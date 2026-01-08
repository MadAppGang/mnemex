# Architecture Document: Extended Language Support and Document Indexing

**Feature ID:** extended-language-support-v1
**Created:** 2026-01-06
**Status:** Design Complete
**Owner:** Development Team

---

## 1. Executive Summary

This architecture extends claudemem's semantic code search to support 18 additional file types:
- **8 code languages**: HTML, CSS, SCSS, Bash, JSON, YAML, TOML, GraphQL
- **4 document formats**: Markdown, RST, AsciiDoc, Org
- **Shell variants**: Fish, Zsh (via Bash grammar)
- **Enhanced docstring extraction**: All supported languages (10 existing + 8 new)

### Key Architectural Decisions

1. **Modular Language Configuration**: Extend existing `LANGUAGE_CONFIGS` pattern for new languages
2. **Header-Based Document Chunking**: New module `src/parsers/document-chunker.ts` for text-based files
3. **Docstring Extractor**: New module `src/parsers/docstring-extractor.ts` leveraging AST queries
4. **Backward Compatibility**: Zero schema changes to `CodeChunk` type; use existing fields creatively
5. **Fallback Strategy**: All new languages have regex-based fallback if tree-sitter grammar unavailable

---

## 2. System Architecture Overview

### 2.1 Component Hierarchy

```
claudemem/
├── src/
│   ├── parsers/
│   │   ├── parser-manager.ts          [MODIFIED] Add 8 new language configs
│   │   ├── document-chunker.ts        [NEW] Header-based chunking for docs
│   │   └── docstring-extractor.ts     [NEW] Extract docstrings from AST
│   ├── core/
│   │   ├── chunker.ts                 [MODIFIED] Route to doc/code chunker
│   │   └── analysis/
│   │       └── test-detector.ts       [MODIFIED] Add patterns for new langs
│   ├── types.ts                       [MODIFIED] Add new ChunkType values
│   └── scripts/
│       └── download-grammars.ts       [MODIFIED] Download 8 new grammars
├── grammars/                          [EXPANDED] +8 WASM files
└── test/
    └── fixtures/                      [NEW] Sample files for each new type
```

### 2.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     File Indexing Pipeline                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 ┌────────────────────────┐
                 │  File Path Detection   │
                 │  (parser-manager.ts)   │
                 └────────────────────────┘
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
    ┌─────────────────────┐   ┌─────────────────────┐
    │  Code Languages      │   │  Document Formats   │
    │  (TS, JS, Go, etc.)  │   │  (MD, RST, etc.)    │
    └─────────────────────┘   └─────────────────────┘
                 │                         │
                 ▼                         ▼
    ┌─────────────────────┐   ┌─────────────────────┐
    │  Tree-sitter Parse  │   │  Header Detection   │
    │  (chunker.ts)       │   │  (document-chunker) │
    └─────────────────────┘   └─────────────────────┘
                 │                         │
                 ▼                         │
    ┌─────────────────────┐               │
    │  Docstring Extract  │               │
    │  (docstring-extract)│               │
    └─────────────────────┘               │
                 │                         │
                 └────────────┬────────────┘
                              ▼
                    ┌──────────────────┐
                    │  CodeChunk[]     │
                    │  (unified output)│
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Embedding + DB  │
                    │  (LanceDB)       │
                    └──────────────────┘
```

---

## 3. Component Design

### 3.1 Modified: `src/parsers/parser-manager.ts`

**Changes Required:**

1. **Extend `SupportedLanguage` type** (in `src/types.ts`):
```typescript
export type SupportedLanguage =
  | "typescript" | "javascript" | "tsx" | "jsx"
  | "python" | "go" | "rust" | "c" | "cpp" | "java"
  // NEW: Web languages
  | "html" | "css" | "scss"
  // NEW: Shell scripts
  | "bash" | "fish" | "zsh"
  // NEW: Data languages
  | "graphql"
  // NEW: Config formats
  | "json" | "yaml" | "toml"
  // NEW: Document formats
  | "markdown" | "rst" | "asciidoc" | "org";
```

2. **Add 18 new language configurations to `LANGUAGE_CONFIGS`**:

```typescript
// Example: HTML
html: {
  id: "html",
  extensions: [".html", ".htm"],
  grammarFile: "tree-sitter-html.wasm",
  chunkQuery: `
    (element
      (start_tag (tag_name) @name)) @chunk
    (script_element) @chunk
    (style_element) @chunk
  `,
  referenceQuery: `
    ; Class references in attributes
    (attribute
      (attribute_name) @attr (#eq? @attr "class")
      (quoted_attribute_value) @ref.class)
  `,
},

// Example: Bash
bash: {
  id: "bash",
  extensions: [".sh", ".bash", ".zsh"], // Zsh uses bash grammar
  grammarFile: "tree-sitter-bash.wasm",
  chunkQuery: `
    (function_definition
      name: (word) @name) @chunk
  `,
  referenceQuery: `
    ; Command calls
    (command
      name: (command_name) @ref.call)
  `,
},

// Example: Markdown (uses document-chunker, minimal tree-sitter query)
markdown: {
  id: "markdown",
  extensions: [".md", ".markdown"],
  grammarFile: "tree-sitter-markdown.wasm",
  chunkQuery: `
    ; Header-based chunking handled by document-chunker.ts
    (atx_heading) @chunk
    (section) @chunk
  `,
  // No reference query for documents
},
```

**Full List of New Configs:**
- `html`, `css`, `scss`, `bash`, `fish`, `zsh`, `json`, `yaml`, `toml`, `graphql`
- `markdown`, `rst`, `asciidoc`, `org`

3. **Update `EXTENSION_TO_LANGUAGE` mapping** (auto-generated from configs)

**API Contract:** No breaking changes. Existing `getLanguage()`, `isSupported()` methods continue to work with expanded language set.

---

### 3.2 NEW: `src/parsers/document-chunker.ts`

**Purpose:** Header-based chunking for Markdown, RST, AsciiDoc, Org files.

**Exported Functions:**

```typescript
/**
 * Check if a file is a document format (not code)
 */
export function isDocumentFormat(language: string): boolean {
  return ["markdown", "rst", "asciidoc", "org"].includes(language);
}

/**
 * Chunk a document file by headers
 */
export async function chunkDocument(
  source: string,
  filePath: string,
  language: "markdown" | "rst" | "asciidoc" | "org",
  fileHash: string
): Promise<CodeChunk[]> {
  // 1. Detect headers using regex patterns (fallback-first approach)
  // 2. Split content by headers, preserving hierarchy
  // 3. Apply size limits (split large sections)
  // 4. Extract metadata (heading level, parent heading)
  // 5. Return CodeChunk[] with chunkType="document-section"
}

/**
 * Extract header hierarchy from document
 */
interface DocumentHeader {
  level: number;        // 1 = h1, 2 = h2, etc.
  text: string;         // Header text
  startLine: number;
  endLine: number;
  content: string;      // Section content (excluding header)
  parentHeader?: string; // Parent section title
}

function extractHeaders(
  source: string,
  language: "markdown" | "rst" | "asciidoc" | "org"
): DocumentHeader[] {
  // Language-specific header patterns
  const patterns = {
    markdown: /^(#{1,6})\s+(.+)$/gm,        // # Header
    rst: /^(.+)\n([=\-`:.'"~^_*+#]+)$/gm,   // Underline style
    asciidoc: /^(={1,6})\s+(.+)$/gm,        // = Header
    org: /^(\*{1,6})\s+(.+)$/gm,            // * Header
  };

  // Parse headers, build hierarchy, split content
}

/**
 * Split large document sections
 */
function splitLargeSection(
  section: DocumentHeader,
  maxTokens: number = 1500
): DocumentHeader[] {
  // Split by paragraphs or code blocks
  // Preserve code blocks intact
  // Return array of sub-sections
}
```

**Algorithm: Header-Based Chunking**

1. **Parse Headers**: Use regex to find all headers and their levels
2. **Build Hierarchy**: Track parent-child relationships (h1 > h2 > h3)
3. **Extract Content**: Get text between headers
4. **Size Limiting**:
   - If section < MAX_CHUNK_TOKENS: single chunk
   - If section > MAX_CHUNK_TOKENS: split by paragraphs/code blocks
   - Preserve code blocks intact (no splitting mid-block)
5. **Create Chunks**:
   - `chunkType: "document-section"`
   - `name: header text`
   - `parentName: parent header text` (if nested)
   - `signature: "# Header Title"` (original header syntax)
   - Use existing `CodeChunk` fields (no schema changes)

**Metadata Storage in Existing Fields:**

```typescript
// Example CodeChunk for Markdown section
{
  id: "sha256...",
  content: "## Installation\n\nRun `npm install`...",
  filePath: "README.md",
  startLine: 15,
  endLine: 32,
  language: "markdown",
  chunkType: "document-section",  // NEW chunk type
  name: "Installation",            // Header text
  parentName: "Getting Started",   // Parent header (if nested)
  signature: "## Installation",    // Full header syntax
  fileHash: "abc123...",
}
```

**Size Limits:**
- `MAX_CHUNK_TOKENS = 1500` (from existing chunker.ts)
- `MIN_CHUNK_TOKENS = 50` (skip tiny sections)
- `CHARS_PER_TOKEN = 4` (existing estimate)

**Code Block Preservation:**
```typescript
// Regex to detect code blocks
const codeBlockPatterns = {
  markdown: /```[\s\S]*?```/g,
  rst: /::[\s\S]*?(?=\n\S)/g,
  asciidoc: /----[\s\S]*?----/g,
  org: /#\+begin_src[\s\S]*?#\+end_src/gi,
};

// When splitting, never split inside code blocks
```

---

### 3.3 NEW: `src/parsers/docstring-extractor.ts`

**Purpose:** Extract documentation comments from all code languages.

**Exported Functions:**

```typescript
/**
 * Extract docstrings from source code
 */
export async function extractDocstrings(
  source: string,
  filePath: string,
  language: SupportedLanguage,
  fileHash: string
): Promise<CodeChunk[]> {
  // 1. Parse source with tree-sitter
  // 2. Execute language-specific docstring query
  // 3. Extract comments attached to symbols
  // 4. Return CodeChunk[] with chunkType="docstring"
}

/**
 * Get docstring query for a language
 */
function getDocstringQuery(language: SupportedLanguage): string {
  const queries = {
    typescript: `
      ; JSDoc comments
      (comment) @docstring
      (#match? @docstring "^/\\*\\*")
    `,
    python: `
      ; Docstrings (triple-quoted strings)
      (function_definition
        body: (block . (expression_statement (string) @docstring)))
      (class_definition
        body: (block . (expression_statement (string) @docstring)))
    `,
    rust: `
      ; Doc comments
      (line_comment) @docstring
      (#match? @docstring "^///")
      (block_comment) @docstring
      (#match? @docstring "^/\\*\\*")
    `,
    go: `
      ; Doc comments (preceding declarations)
      (comment) @docstring
      (#match? @docstring "^//")
    `,
    // ... more languages
  };
  return queries[language] || "";
}

/**
 * Link docstring to parent symbol
 */
function findParentSymbol(docstringNode: Node, tree: Tree): string | undefined {
  // Find next sibling that's a function/class/method
  // Return its name
}
```

**Chunk Structure:**

```typescript
// Example: Docstring chunk
{
  id: "sha256...",
  content: "/**\n * Calculates the fibonacci sequence.\n * @param n - Input number\n * @returns The nth fibonacci number\n */",
  filePath: "src/math.ts",
  startLine: 5,
  endLine: 9,
  language: "typescript",
  chunkType: "docstring",       // NEW chunk type
  name: "fibonacci (docstring)", // Symbol name + "(docstring)"
  parentName: "fibonacci",       // Symbol this documents
  signature: undefined,          // Not applicable
  fileHash: "def456...",
}
```

**Language-Specific Docstring Patterns:**

| Language   | Pattern                          | AST Node Type       |
|------------|----------------------------------|---------------------|
| TypeScript | `/** ... */`                     | `comment`           |
| JavaScript | `/** ... */`                     | `comment`           |
| Python     | `"""..."""` or `'''...'''`       | `string` (first in body) |
| Rust       | `///` or `//!`                   | `line_comment`      |
| Go         | `//` (preceding declaration)     | `comment`           |
| Java       | `/** ... */`                     | `comment`           |
| C/C++      | `/** ... */`                     | `comment`           |

**Filtering Rules:**

1. **Include**:
   - Multi-line block comments (`/** */`, `"""`)
   - Doc comments preceding symbols (`///`, `//` in Go)
   - File-level header comments

2. **Exclude**:
   - Inline comments (`//`, `#` single-line)
   - TODOs, FIXMEs (too noisy)
   - Comments inside function bodies (unless Python docstring)

---

### 3.4 Modified: `src/core/chunker.ts`

**Changes Required:**

1. **Add routing logic** to `chunkFile()`:

```typescript
export async function chunkFile(
  source: string,
  filePath: string,
  language: SupportedLanguage,
  fileHash: string,
): Promise<CodeChunk[]> {
  const parserManager = getParserManager();

  // NEW: Route document formats to document chunker
  if (isDocumentFormat(language)) {
    return chunkDocument(source, filePath, language as any, fileHash);
  }

  // Existing code parsing logic
  const tree = await parserManager.parse(source, language);
  if (!tree) {
    return fallbackChunk(source, filePath, language, fileHash);
  }

  // ... existing chunking logic ...

  // NEW: Extract docstrings in parallel
  const docstrings = await extractDocstrings(source, filePath, language, fileHash);

  // Combine code chunks + docstrings
  return [...chunks, ...docstrings];
}
```

2. **Update `getChunkType()`** to handle new node types:

```typescript
function getChunkType(nodeType: string, language: SupportedLanguage): ChunkType | null {
  // NEW: Document sections
  if (["atx_heading", "section"].includes(nodeType)) {
    return "document-section";
  }

  // NEW: CSS rulesets
  if (nodeType === "rule_set") {
    return "stylesheet-rule";
  }

  // NEW: GraphQL types
  if (["type_definition", "interface_definition"].includes(nodeType)) {
    return "type";
  }

  // NEW: Shell functions
  if (nodeType === "function_definition" && language === "bash") {
    return "shell-function";
  }

  // Existing logic...
}
```

---

### 3.5 Modified: `src/types.ts`

**Changes Required:**

1. **Extend `ChunkType` union**:

```typescript
export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "module"
  | "block"
  // NEW: Document types
  | "document-section"
  | "docstring"
  // NEW: Language-specific types
  | "stylesheet-rule"
  | "config-section"
  | "shell-function"
  | "query";
```

2. **NO changes to `CodeChunk` interface** (use existing fields):

```typescript
export interface CodeChunk {
  // Existing fields remain unchanged
  id: string;
  contentHash: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;        // Now supports 28 languages
  chunkType: ChunkType;    // Now supports 10 chunk types
  name?: string;           // For docs: header text
  parentName?: string;     // For docs: parent header
  signature?: string;      // For docs: full header syntax
  fileHash: string;
}
```

**Rationale:** Existing fields are sufficient:
- `name`: Header text for documents, function name for code
- `parentName`: Parent header for nested sections, class for methods
- `signature`: Full header syntax (e.g., `## Installation`)
- No new fields needed

---

### 3.6 Modified: `scripts/download-grammars.ts`

**Changes Required:**

1. **Add 8 new grammar packages**:

```typescript
const GRAMMAR_PACKAGES = [
  // Existing 10 languages...

  // NEW: Web languages
  { pkg: "tree-sitter-html", wasm: ["tree-sitter-html.wasm"] },
  { pkg: "tree-sitter-css", wasm: ["tree-sitter-css.wasm"] },
  { pkg: "tree-sitter-scss", wasm: ["tree-sitter-scss.wasm"] },

  // NEW: Shell scripts
  { pkg: "tree-sitter-bash", wasm: ["tree-sitter-bash.wasm"] },
  { pkg: "@esdmr/tree-sitter-fish", wasm: ["tree-sitter-fish.wasm"] },

  // NEW: Data languages
  { pkg: "tree-sitter-graphql", wasm: ["tree-sitter-graphql.wasm"] },

  // NEW: Config formats
  { pkg: "tree-sitter-json", wasm: ["tree-sitter-json.wasm"] },
  { pkg: "tree-sitter-yaml", wasm: ["tree-sitter-yaml.wasm"] },
  { pkg: "tree-sitter-toml", wasm: ["tree-sitter-toml.wasm"] },

  // NEW: Documents (optional, use fallback if unavailable)
  { pkg: "@tree-sitter-grammars/tree-sitter-markdown", wasm: ["tree-sitter-markdown.wasm"] },
];
```

2. **Add download URLs** from research:

```typescript
const GITHUB_RELEASES: Record<string, string> = {
  // Existing URLs...

  // NEW URLs (from research.md)
  "tree-sitter-html.wasm": "https://unpkg.com/tree-sitter-html/tree-sitter-html.wasm",
  "tree-sitter-css.wasm": "https://unpkg.com/tree-sitter-css/tree-sitter-css.wasm",
  "tree-sitter-scss.wasm": "https://unpkg.com/tree-sitter-scss/tree-sitter-scss.wasm",
  "tree-sitter-bash.wasm": "https://unpkg.com/tree-sitter-bash/tree-sitter-bash.wasm",
  "tree-sitter-fish.wasm": "https://unpkg.com/@esdmr/tree-sitter-fish/tree-sitter-fish.wasm",
  "tree-sitter-json.wasm": "https://unpkg.com/tree-sitter-json/tree-sitter-json.wasm",
  "tree-sitter-yaml.wasm": "https://unpkg.com/tree-sitter-yaml/tree-sitter-yaml.wasm",
  "tree-sitter-toml.wasm": "https://unpkg.com/tree-sitter-toml/tree-sitter-toml.wasm",
  "tree-sitter-graphql.wasm": "https://unpkg.com/tree-sitter-graphql/tree-sitter-graphql.wasm",
};
```

---

### 3.7 Modified: `src/core/analysis/test-detector.ts`

**Changes Required:**

Add test file patterns for new languages:

```typescript
const TEST_PATTERNS: Record<SupportedLanguage, TestPattern> = {
  // Existing patterns...

  // NEW: Bash
  bash: {
    filePatterns: [/_test\.sh$/, /test_.*\.sh$/],
    dirPatterns: [/\/tests?\//],
    symbolPatterns: [/^test_/],
  },

  // NEW: Fish
  fish: {
    filePatterns: [/_test\.fish$/, /test_.*\.fish$/],
    dirPatterns: [/\/tests?\//],
    symbolPatterns: [/^test_/],
  },

  // Documents/configs: no test patterns (not applicable)
};
```

---

## 4. Data Flow: Document Chunking

### 4.1 Header Detection Algorithm

```
Input: Markdown file content
┌────────────────────────────────────────┐
│ # Main Title                           │ ← Level 1
│ This is the intro.                     │
│                                        │
│ ## Section A                           │ ← Level 2, parent: "Main Title"
│ Content of section A.                  │
│                                        │
│ ### Subsection A.1                     │ ← Level 3, parent: "Section A"
│ Detailed content here.                 │
│                                        │
│ ## Section B                           │ ← Level 2, parent: "Main Title"
│ Content of section B.                  │
└────────────────────────────────────────┘

Output: CodeChunk[] = [
  {
    chunkType: "document-section",
    name: "Main Title",
    content: "# Main Title\nThis is the intro.",
    startLine: 1,
    endLine: 2,
    parentName: undefined,
    signature: "# Main Title",
  },
  {
    chunkType: "document-section",
    name: "Section A",
    content: "## Section A\nContent of section A.",
    startLine: 4,
    endLine: 5,
    parentName: "Main Title",
    signature: "## Section A",
  },
  {
    chunkType: "document-section",
    name: "Subsection A.1",
    content: "### Subsection A.1\nDetailed content here.",
    startLine: 7,
    endLine: 8,
    parentName: "Section A",
    signature: "### Subsection A.1",
  },
  // ...
]
```

### 4.2 Size Limit Handling

```
If section > MAX_CHUNK_TOKENS (1500):

┌─────────────────────────────────────────┐
│ ## Large Section (2000 tokens)          │
│                                         │
│ Paragraph 1 (500 tokens)                │ ← Chunk 1
│                                         │
│ Paragraph 2 (800 tokens)                │ ← Chunk 2
│                                         │
│ ```python                               │
│ # Code block (300 tokens)               │ ← Chunk 3 (preserve intact)
│ ```                                     │
│                                         │
│ Paragraph 3 (400 tokens)                │ ← Chunk 3 (combined if fits)
└─────────────────────────────────────────┘

Split Strategy:
1. Paragraph boundaries (double newline)
2. Code block boundaries (preserve intact)
3. List boundaries (unordered/ordered lists)
4. Fallback: Hard split at MAX_CHUNK_TOKENS
```

### 4.3 Code Block Detection

```typescript
// Preserve code blocks across split boundaries
function isInsideCodeBlock(text: string, position: number): boolean {
  const beforeText = text.slice(0, position);
  const openBlocks = (beforeText.match(/```/g) || []).length;
  return openBlocks % 2 === 1; // Odd number = inside block
}

// Never split here:
## Section
Some text.
```typescript  ← Start of code block
function foo() {
  return 42;
}
```           ← End of code block
More text.
```

---

## 5. API Contracts

### 5.1 Parser Manager

**No Breaking Changes**

Existing methods work with expanded language set:

```typescript
// Existing API (unchanged)
getLanguage(filePath: string): SupportedLanguage | null;
isSupported(filePath: string): boolean;
getParser(language: SupportedLanguage): Promise<Parser | null>;

// Now returns 28 languages instead of 10
getSupportedLanguages(): SupportedLanguage[];

// Now returns 40+ extensions instead of 20
getSupportedExtensions(): string[];
```

### 5.2 Chunker

**Signature Unchanged**

```typescript
// Existing API (unchanged)
export async function chunkFile(
  source: string,
  filePath: string,
  language: SupportedLanguage,
  fileHash: string,
): Promise<CodeChunk[]>;

// Internally routes to:
// - extractChunks() for code languages
// - chunkDocument() for document formats
// - extractDocstrings() for all languages
```

**Output:** Always returns `CodeChunk[]` (backward compatible)

### 5.3 Document Chunker (New)

```typescript
/**
 * Chunk a document file by headers
 *
 * @param source - File content
 * @param filePath - Relative file path
 * @param language - Document format (markdown, rst, asciidoc, org)
 * @param fileHash - SHA256 hash of file
 * @returns Array of CodeChunk with chunkType="document-section"
 */
export async function chunkDocument(
  source: string,
  filePath: string,
  language: "markdown" | "rst" | "asciidoc" | "org",
  fileHash: string
): Promise<CodeChunk[]>;

/**
 * Check if language is a document format
 */
export function isDocumentFormat(language: string): boolean;
```

### 5.4 Docstring Extractor (New)

```typescript
/**
 * Extract docstrings from source code
 *
 * @param source - File content
 * @param filePath - Relative file path
 * @param language - Programming language
 * @param fileHash - SHA256 hash of file
 * @returns Array of CodeChunk with chunkType="docstring"
 */
export async function extractDocstrings(
  source: string,
  filePath: string,
  language: SupportedLanguage,
  fileHash: string
): Promise<CodeChunk[]>;

/**
 * Get docstring tree-sitter query for a language
 */
export function getDocstringQuery(language: SupportedLanguage): string;
```

---

## 6. Database Schema

### 6.1 NO Schema Changes Required

**Rationale:** Existing `CodeChunk` type is flexible enough:

```typescript
// LanceDB schema (unchanged)
{
  id: string,
  contentHash: string,
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  language: string,        // Now accepts 28 values
  chunkType: string,       // Now accepts 10 values
  name?: string,
  parentName?: string,
  signature?: string,
  fileHash: string,
  vector: Float32Array,    // Embedding (existing)
}
```

### 6.2 Backward Compatibility

**Existing Indexes:** Work without migration
- Old chunks: `chunkType: "function" | "class" | "method" | "module" | "block"`
- New chunks: `chunkType: "document-section" | "docstring" | "stylesheet-rule" | ...`
- Search: Works across old and new chunk types
- Filters: Can filter by new chunk types

**Migration:** Not required
- Re-indexing will pick up new chunk types
- Old indexes continue to work
- Incremental updates supported

---

## 7. Implementation Phases

### Phase 1: Web Languages (Week 1)
**Goal:** Add HTML, CSS, SCSS support with tree-sitter

**Tasks:**
1. Add language configs to `parser-manager.ts` (HTML, CSS, SCSS)
2. Write tree-sitter chunk queries for HTML (elements, scripts, styles)
3. Write tree-sitter chunk queries for CSS (rulesets, selectors)
4. Update `download-grammars.ts` to fetch WASM files
5. Add unit tests with fixture files
6. Update README with supported languages

**Dependencies:** None (foundational)

**Acceptance Criteria:**
- `claudemem index` successfully indexes `.html`, `.css`, `.scss` files
- `claudemem search "button style"` returns CSS rulesets
- Tests pass for all 3 languages

---

### Phase 2: Shell Scripts (Week 1-2)
**Goal:** Add Bash, Fish, Zsh support

**Tasks:**
1. Add language configs for `bash`, `fish`, `zsh`
2. Write chunk query for bash function extraction
3. Implement Fish-specific parsing (or use bash fallback)
4. Update test-detector.ts with shell test patterns
5. Add integration tests (sample .sh, .fish files)

**Dependencies:** Phase 1 (grammar download system)

**Acceptance Criteria:**
- Shell scripts indexed with function-level chunks
- `claudemem search "deployment script"` returns bash functions
- Fish scripts use dedicated grammar or bash fallback

---

### Phase 3: Data Languages (Week 2)
**Goal:** Add GraphQL support

**Tasks:**
1. Add GraphQL language config
2. Write chunk query for types, queries, mutations
3. Download tree-sitter-graphql WASM
4. Add tests with sample .graphql schemas

**Dependencies:** Phase 1

**Acceptance Criteria:**
- GraphQL schemas indexed by type definitions
- `claudemem search "user type"` returns GraphQL types

---

### Phase 4: Config Formats (Week 2-3)
**Goal:** Add JSON, YAML, TOML support

**Tasks:**
1. Add language configs for json, yaml, toml
2. Implement top-level key extraction as chunks
3. Handle nested config chunking (limit depth to 2 levels)
4. Add size-based splitting for large configs
5. Test with real-world config files (package.json, docker-compose.yml)

**Dependencies:** Phase 1

**Acceptance Criteria:**
- Config files chunked by top-level keys
- `claudemem search "database settings"` returns YAML sections
- Large configs (>1500 tokens) split intelligently

---

### Phase 5: Document Formats (Week 3-4)
**Goal:** Add Markdown, RST, AsciiDoc, Org support

**Tasks:**
1. Implement `src/parsers/document-chunker.ts` module
2. Write header detection regex for each format
3. Implement hierarchy tracking (parent headers)
4. Implement size-based section splitting
5. Add code block preservation logic
6. Write comprehensive tests for edge cases
7. Integrate with main chunker pipeline

**Dependencies:** Phase 1 (test framework)

**Acceptance Criteria:**
- Documents chunked by headers with hierarchy preserved
- Large sections (>1500 tokens) split at paragraph boundaries
- Code blocks preserved intact (no mid-block splits)
- `claudemem search "installation guide"` returns README sections
- Parent header tracked in `parentName` field

---

### Phase 6: Docstring Extraction (Week 4-5)
**Goal:** Extract docstrings from all 18 supported languages

**Tasks:**
1. Implement `src/parsers/docstring-extractor.ts` module
2. Write tree-sitter queries for 10 existing languages
3. Write tree-sitter queries for 8 new languages
4. Implement parent symbol linking
5. Filter out inline comments (keep only doc comments)
6. Add tests for each language's docstring format
7. Integrate with main chunker pipeline

**Dependencies:** Phases 1-5 (all language parsers)

**Acceptance Criteria:**
- JSDoc, Python docstrings, Rustdoc extracted as separate chunks
- `claudemem search "authentication example"` returns docstrings
- Docstrings linked to parent symbols via `parentName`
- Inline comments excluded (not indexed)

---

### Phase 7: Polish & Optimization (Week 5-6)
**Goal:** Performance tuning, edge case handling, documentation

**Tasks:**
1. Optimize regex patterns for document parsing
2. Add caching for repeated grammar loads
3. Benchmark indexing speed for new file types
4. Fix bugs from beta testing
5. Update AI skill documents (ai-skill.ts)
6. Update CLAUDE.md with new capabilities
7. Add examples to README for each new language
8. Write migration guide (none needed, but document this)

**Dependencies:** Phases 1-6 (all features)

**Acceptance Criteria:**
- Indexing speed < 2x slowdown for mixed codebases
- All user stories satisfied (see requirements.md)
- Documentation complete
- CI/CD passing

---

## 8. Testing Strategy

### 8.1 Unit Tests

**Per-Language Tests** (create fixture files):

```typescript
// test/parsers/parser-manager.test.ts
describe("Language Detection", () => {
  test("detects HTML files", () => {
    expect(getLanguage("index.html")).toBe("html");
    expect(getLanguage("page.htm")).toBe("html");
  });

  test("detects Bash files", () => {
    expect(getLanguage("deploy.sh")).toBe("bash");
    expect(getLanguage("install.bash")).toBe("bash");
    expect(getLanguage("setup.zsh")).toBe("bash"); // Zsh uses bash grammar
  });

  // ... test all 18 new languages
});

// test/parsers/document-chunker.test.ts
describe("Document Chunker", () => {
  test("chunks Markdown by headers", async () => {
    const source = `# Title\nIntro\n## Section\nContent`;
    const chunks = await chunkDocument(source, "README.md", "markdown", "hash");

    expect(chunks).toHaveLength(2);
    expect(chunks[0].name).toBe("Title");
    expect(chunks[1].name).toBe("Section");
    expect(chunks[1].parentName).toBe("Title");
  });

  test("splits large sections", async () => {
    const largeSection = "## Big\n" + "a".repeat(10000); // >1500 tokens
    const chunks = await chunkDocument(largeSection, "doc.md", "markdown", "hash");

    expect(chunks.length).toBeGreaterThan(1); // Split into multiple
  });

  test("preserves code blocks", async () => {
    const source = "## Code\n```js\nfoo()\nbar()\n```\nMore text";
    const chunks = await chunkDocument(source, "doc.md", "markdown", "hash");

    // Code block should not be split
    expect(chunks[0].content).toContain("```js\nfoo()\nbar()\n```");
  });
});

// test/parsers/docstring-extractor.test.ts
describe("Docstring Extractor", () => {
  test("extracts JSDoc from TypeScript", async () => {
    const source = `
      /** This is a docstring */
      function foo() {}
    `;
    const chunks = await extractDocstrings(source, "test.ts", "typescript", "hash");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("docstring");
    expect(chunks[0].parentName).toBe("foo");
  });

  test("extracts Python docstrings", async () => {
    const source = `
      def foo():
          """This is a docstring"""
          pass
    `;
    const chunks = await extractDocstrings(source, "test.py", "python", "hash");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("This is a docstring");
  });

  // Test all 18 languages
});
```

### 8.2 Integration Tests

**End-to-End Indexing:**

```typescript
// test/integration/extended-languages.test.ts
describe("Extended Language Indexing", () => {
  test("indexes HTML project", async () => {
    const indexer = await createIndexer("test/fixtures/html-project");
    const result = await indexer.indexAll();

    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // Search for HTML elements
    const results = await search("button component");
    expect(results.length).toBeGreaterThan(0);
  });

  test("indexes documentation project", async () => {
    const indexer = await createIndexer("test/fixtures/docs-project");
    const result = await indexer.indexAll();

    // Check document sections created
    const docChunks = result.chunks.filter(c => c.chunkType === "document-section");
    expect(docChunks.length).toBeGreaterThan(0);

    // Search by header name
    const results = await search("installation guide");
    expect(results[0].chunk.name).toContain("Installation");
  });
});
```

### 8.3 Fixture Files

Create comprehensive test fixtures:

```
test/fixtures/
├── html-project/
│   ├── index.html           (with sections, scripts, styles)
│   ├── components/
│   │   └── button.html
│   └── styles/
│       ├── main.css         (with rulesets, media queries)
│       └── theme.scss       (with mixins, variables)
├── shell-project/
│   ├── deploy.sh            (with functions)
│   ├── utils.fish           (fish-specific syntax)
│   └── tests/
│       └── test_deploy.sh   (test file detection)
├── config-project/
│   ├── package.json         (large nested config)
│   ├── docker-compose.yml   (multi-service config)
│   └── settings.toml        (TOML syntax)
├── docs-project/
│   ├── README.md            (nested headers, code blocks)
│   ├── guide.rst            (RST syntax)
│   ├── manual.adoc          (AsciiDoc syntax)
│   └── notes.org            (Org-mode syntax)
└── graphql-project/
    └── schema.graphql       (types, queries, mutations)
```

### 8.4 Edge Case Tests

```typescript
// Edge cases to test
describe("Edge Cases", () => {
  test("handles empty documents", async () => {
    const chunks = await chunkDocument("", "empty.md", "markdown", "hash");
    expect(chunks).toHaveLength(0);
  });

  test("handles documents without headers", async () => {
    const chunks = await chunkDocument("Plain text", "plain.md", "markdown", "hash");
    // Should create single chunk or skip (decision needed)
  });

  test("handles malformed headers", async () => {
    const source = "#Missing space\n## Valid Header";
    const chunks = await chunkDocument(source, "bad.md", "markdown", "hash");
    // Should handle gracefully
  });

  test("handles deeply nested headers", async () => {
    const source = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    const chunks = await chunkDocument(source, "deep.md", "markdown", "hash");
    expect(chunks[5].parentName).toBe("H5");
  });

  test("handles code blocks with header syntax", async () => {
    const source = "## Section\n```md\n# This is not a header\n```";
    const chunks = await chunkDocument(source, "tricky.md", "markdown", "hash");
    expect(chunks).toHaveLength(1); // Should not detect header inside code block
  });
});
```

### 8.5 Performance Tests

```typescript
// test/performance/chunking-benchmark.test.ts
describe("Chunking Performance", () => {
  test("indexes 1000 Markdown files in <10s", async () => {
    const startTime = Date.now();
    // Index large markdown project
    const endTime = Date.now();

    expect(endTime - startTime).toBeLessThan(10000);
  });

  test("document chunking is O(n) in file size", () => {
    // Benchmark parsing 1KB, 10KB, 100KB, 1MB files
    // Verify linear time complexity
  });
});
```

---

## 9. Key Design Decisions

### 9.1 Why No Schema Changes?

**Decision:** Reuse existing `CodeChunk` fields instead of adding new fields.

**Rationale:**
1. **Backward Compatibility**: Existing indexes work without migration
2. **Simplicity**: Fewer types to maintain
3. **Flexibility**: `name`, `parentName`, `signature` are semantic, not syntax-specific
4. **Vector Space**: Documents and code share same embedding space (useful for cross-search)

**Trade-offs:**
- Pro: Zero migration needed
- Pro: Unified search across docs and code
- Con: Field semantics overloaded (e.g., `signature` means different things)
- Con: No type-level enforcement of document-specific metadata

**Mitigation:** Document field semantics clearly in code comments and API docs.

---

### 9.2 Why Header-Based Chunking?

**Decision:** Chunk documents by headers (# ## ###) instead of fixed-size splits.

**Rationale:**
1. **Semantic Boundaries**: Headers represent logical sections
2. **Hierarchy Preservation**: Parent-child relationships trackable
3. **Search Quality**: "Installation guide" matches section header directly
4. **Natural Size**: Headers naturally limit section size (usually <1500 tokens)

**Trade-offs:**
- Pro: Better semantic relevance
- Pro: Human-readable chunk names
- Con: Header-less documents need special handling
- Con: Uneven chunk sizes (some headers have tiny sections)

**Mitigation:** Apply size limits and split large sections at paragraph boundaries.

---

### 9.3 Why Regex Fallback for Documents?

**Decision:** Use regex for header detection instead of tree-sitter exclusively.

**Rationale:**
1. **Reliability**: Tree-sitter grammars for docs are immature (Markdown WASM issues)
2. **Simplicity**: Header patterns are simple regex (e.g., `/^#{1,6}\s+/`)
3. **Performance**: Regex faster than tree-sitter for simple patterns
4. **Maintainability**: Less dependency on external grammar quality

**Trade-offs:**
- Pro: Works even if tree-sitter grammar unavailable
- Pro: Faster for simple patterns
- Con: Misses complex edge cases (e.g., headers inside code blocks)
- Con: Less robust than AST parsing

**Mitigation:** Use regex to detect code blocks and skip headers inside them.

---

### 9.4 Why Extract Docstrings Separately?

**Decision:** Docstrings are separate `CodeChunk` entries, not embedded in code chunks.

**Rationale:**
1. **Searchability**: Users can search documentation specifically
2. **Deduplication**: Docstrings often repeat function names (noise if combined)
3. **Embedding Quality**: Documentation has different embedding characteristics than code
4. **Filtering**: Easier to filter results by chunk type

**Trade-offs:**
- Pro: Better search precision for docs
- Pro: Can weight docstrings differently in search
- Con: More chunks per file (2x for well-documented code)
- Con: Complexity in linking docstring to parent symbol

**Mitigation:** Use `parentName` field to link docstring to symbol.

---

### 9.5 Why Support Zsh via Bash Grammar?

**Decision:** Zsh files (.zsh) use `tree-sitter-bash` grammar instead of dedicated Zsh grammar.

**Rationale:**
1. **Compatibility**: Bash and Zsh share ~80% syntax
2. **Availability**: No mature tree-sitter-zsh grammar exists
3. **Pragmatism**: Most Zsh scripts use Bash-compatible syntax

**Trade-offs:**
- Pro: Zsh support with zero extra grammars
- Pro: Works for most common Zsh scripts
- Con: Zsh-specific features (e.g., `${(u)array}`) may not parse
- Con: Less accurate symbol extraction for complex Zsh

**Mitigation:** Document limitation in README; users can use `.sh` extension for compatibility.

---

## 10. Risk Analysis

### 10.1 Grammar Availability Risk

**Risk:** Tree-sitter grammars for some languages (RST, AsciiDoc, Org) unavailable or immature.

**Impact:** HIGH (blocks feature for those formats)

**Probability:** MEDIUM (research shows RST, Org grammars exist but not on npm)

**Mitigation:**
1. Implement regex fallback for all document formats (works without tree-sitter)
2. Download grammars from GitHub releases as backup
3. Build WASM from source if needed (document process)
4. Phase implementation: start with Markdown (proven grammar), add others later

**Fallback Plan:** Ship Markdown-only in Phase 5, add RST/AsciiDoc/Org in Phase 7 if demand exists.

---

### 10.2 Performance Degradation Risk

**Risk:** Indexing 2-3x more file types degrades performance.

**Impact:** MEDIUM (slower indexing frustrates users)

**Probability:** MEDIUM (more files = more processing)

**Mitigation:**
1. Lazy-load grammars (only load when file type encountered)
2. Parallel processing (already implemented for embeddings)
3. Benchmark each phase and optimize bottlenecks
4. Document chunker optimized for O(n) complexity (single-pass regex)

**Success Criteria:** <20% indexing time increase for typical projects (measured in Phase 7).

---

### 10.3 Docstring Extraction Accuracy Risk

**Risk:** Docstring extraction misses comments or links to wrong symbols.

**Impact:** MEDIUM (poor search quality for docs)

**Probability:** HIGH (complex AST traversal, language-specific patterns)

**Mitigation:**
1. Comprehensive unit tests for each language's docstring format
2. Conservative approach: only extract obvious doc comments (skip ambiguous cases)
3. User feedback loop: iterate based on real-world usage
4. Graceful degradation: if linking fails, docstring still indexed (just without `parentName`)

**Acceptance:** 90% accuracy in linking docstrings to symbols (measured via manual review).

---

### 10.4 Backward Compatibility Risk

**Risk:** Changes break existing indexes or search behavior.

**Impact:** HIGH (users lose data or trust)

**Probability:** LOW (no schema changes planned)

**Mitigation:**
1. Zero schema changes to `CodeChunk` type
2. New chunk types are additive (old types still work)
3. Regression tests for all existing languages
4. Beta testing with real projects before release

**Verification:** All existing tests pass after each phase.

---

### 10.5 Documentation Chunking Edge Cases

**Risk:** Unexpected Markdown syntax breaks header detection (e.g., headers in code blocks, HTML comments).

**Impact:** MEDIUM (incorrect chunking, noise in results)

**Probability:** HIGH (Markdown has many edge cases)

**Mitigation:**
1. Code block detection (skip headers inside ```)
2. HTML comment detection (skip headers in `<!-- -->`)
3. Comprehensive edge case tests (see Section 8.4)
4. Fallback to full-file chunk if parsing fails

**Monitoring:** Track parse failures in telemetry; add edge cases to test suite iteratively.

---

## 11. Open Questions & Resolutions

### OQ-1: Configuration File Chunking Depth

**Question:** Should we chunk nested YAML/JSON (e.g., `database.postgres.host`) or just top-level keys?

**Options:**
- A. Top-level only (simpler, faster)
- B. Nested keys up to 2 levels deep (more granular)
- C. Configurable depth (flexible but complex)

**Resolution:** **Option A** for Phase 4 implementation
- Start with top-level keys only
- Monitor user feedback for nested key demand
- Iterate to Option B in Phase 7 if needed

---

### OQ-2: Document Code Block Handling

**Question:** Should code blocks within Markdown be indexed separately as code?

**Options:**
- A. Index as part of document chunk (simpler)
- B. Extract and index as code with detected language (richer)
- C. Configurable behavior (flexible)

**Resolution:** **Option A** for Phase 5 implementation
- Keep code blocks inside document chunks
- Preserve syntax highlighting language (store in metadata if needed)
- Future enhancement: extract to separate chunks with language detection

---

### OQ-3: Docstring Chunk Type

**Question:** Should docstrings have their own `chunkType` (e.g., "docstring") or share existing types?

**Options:**
- A. New type: `"docstring"` or `"documentation"`
- B. Use existing types with metadata flag: `isDocumentation: true`
- C. Use `"comment"` chunk type

**Resolution:** **Option A** (`chunkType: "docstring"`)
- Clear semantic separation
- Easy filtering in search (`chunkType: "docstring"`)
- Aligns with existing chunk type pattern (explicit > implicit)

---

### OQ-4: Header-less Documents

**Question:** How to handle documents without headers (e.g., plain text README with no #)?

**Options:**
- A. Create single chunk for entire file
- B. Split by paragraphs (double newline)
- C. Skip indexing (treat as unsupported)

**Resolution:** **Option A** for Phase 5 implementation
- Single chunk with `name: filename` (e.g., "README.md")
- `chunkType: "document-section"`
- Future enhancement: smart paragraph splitting if >1500 tokens

---

### OQ-5: CSS/SCSS Symbol Extraction

**Question:** Should CSS rulesets be treated as "symbols" in symbol graph?

**Options:**
- A. Yes, treat selectors as symbols (`.button` → symbol)
- B. No, only index for search (no PageRank)
- C. Configurable via flag

**Resolution:** **Option B** for Phase 1 implementation
- CSS rulesets indexed as chunks but not added to symbol graph
- Rationale: CSS doesn't have "call relationships" like code
- Future enhancement: track class usage in HTML if demanded

---

## 12. Success Metrics

### 12.1 Quantitative Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Language Coverage** | 28 total (10 existing + 18 new) | Count in `LANGUAGE_CONFIGS` |
| **Indexing Success Rate** | >95% of files indexed without errors | CI integration tests |
| **Search Relevance** | >80% relevant results for new file types | User testing with queries |
| **Performance** | <20% indexing time increase | Benchmark suite (Phase 7) |
| **Grammar Availability** | 8/8 new code languages have grammars | Download script success |
| **Docstring Extraction** | >90% accuracy in symbol linking | Manual review (Phase 6) |
| **Test Coverage** | >70% for new code | bun test --coverage |

### 12.2 Qualitative Metrics

| Metric | Target | Validation |
|--------|--------|------------|
| **User Satisfaction** | Positive feedback on language support | User interviews post-release |
| **Issue Rate** | <5 bugs per language in first 2 weeks | GitHub issue tracker |
| **Documentation Quality** | README examples for all languages | Community contributions |
| **Adoption** | >30% of users index new file types | Telemetry (opt-in) |

---

## 13. Future Enhancements (Post-v1)

### 13.1 Additional Languages (v2)

**Potential additions based on user demand:**
- PHP (web backend)
- Ruby (Rails projects)
- Swift (iOS development)
- Kotlin (Android development)
- Scala (JVM projects)
- R (data science)
- Julia (scientific computing)

**Effort:** Medium (grammar availability varies)

---

### 13.2 Smart Code Block Extraction (v2)

**Feature:** Extract code blocks from Markdown as separate chunks with language detection.

**Example:**
````markdown
## Example

```python
def foo():
    return 42
```
````

**Output:**
- Chunk 1: `document-section` (## Example + text)
- Chunk 2: `function` (Python code extracted, language="python")

**Benefits:**
- Better code search within documentation
- Cross-language search (find Python examples in Markdown)

**Effort:** Medium (language detection, AST parsing of embedded code)

---

### 13.3 Multi-Model Embeddings (v3)

**Feature:** Use specialized embedding models for code vs. docs.

**Example:**
- Code: `qwen/qwen3-embedding-8b` (code-optimized)
- Docs: `text-embedding-3-large` (text-optimized)

**Benefits:**
- Higher quality embeddings for each content type
- Better semantic search accuracy

**Challenges:**
- Separate vector spaces (can't compare code to docs directly)
- Complexity in search routing

**Effort:** High (requires dual vector indexes)

---

### 13.4 Jupyter Notebook Support (v2)

**Feature:** Index `.ipynb` files with cell-level chunking.

**Chunk Types:**
- `notebook-code-cell` (Python/R/Julia code)
- `notebook-markdown-cell` (Markdown text)

**Effort:** Medium (JSON parsing, cell extraction)

---

### 13.5 Language-Specific Queries (v3)

**Feature:** Advanced search filters for language-specific constructs.

**Examples:**
- "Find all bash functions that call `curl`"
- "Find GraphQL queries with pagination"
- "Find CSS classes used in HTML"

**Effort:** High (requires AST query system extension)

---

## 14. Documentation Updates Required

### 14.1 README.md

**Additions:**

```markdown
## Supported Languages

claudemem supports 28 programming languages and document formats:

### Code Languages (18)
- **JavaScript/TypeScript**: .js, .jsx, .ts, .tsx, .mjs, .cjs
- **Python**: .py, .pyw, .pyi
- **Go**: .go
- **Rust**: .rs
- **C/C++**: .c, .h, .cpp, .hpp, .cc, .hh
- **Java**: .java
- **HTML**: .html, .htm
- **CSS/SCSS**: .css, .scss
- **Shell Scripts**: .sh, .bash, .zsh, .fish
- **GraphQL**: .graphql, .gql
- **Config Formats**: .json, .yaml, .yml, .toml

### Document Formats (4)
- **Markdown**: .md, .markdown
- **reStructuredText**: .rst
- **AsciiDoc**: .adoc, .asciidoc
- **Org Mode**: .org

### Examples

**Search Markdown documentation:**
```bash
claudemem search "installation guide"
# Returns: README sections by header
```

**Search CSS styles:**
```bash
claudemem search "button primary color"
# Returns: CSS rulesets for .button.primary
```

**Search shell scripts:**
```bash
claudemem search "deploy to production"
# Returns: Bash functions in deploy.sh
```

**Search docstrings:**
```bash
claudemem search "authentication example"
# Returns: JSDoc/docstrings with usage examples
```
```

### 14.2 CLAUDE.md

**Additions:**

```markdown
## Language Support

### Document Formats (NEW in v0.15.0)

claudemem now indexes documentation with intelligent chunking:

- **Header-based chunking**: Markdown, RST, AsciiDoc, Org
- **Hierarchy preservation**: Parent sections tracked in metadata
- **Size limits**: Large sections split at paragraph boundaries
- **Code block preservation**: Code blocks never split mid-block

Example search: `claudemem search "API authentication guide"`
Returns: Documentation sections by header name

### Docstring Extraction (NEW in v0.15.0)

Documentation comments now indexed separately:

- **TypeScript/JavaScript**: JSDoc (`/** ... */`)
- **Python**: Docstrings (`"""..."""`)
- **Rust**: Doc comments (`///`)
- **Go**: Doc comments (`//`)
- **Java**: JavaDoc (`/** ... */`)

Example search: `claudemem search "usage example for auth"`
Returns: Docstrings containing usage patterns

### Web Languages (NEW in v0.15.0)

- **HTML**: Indexed by elements, scripts, styles
- **CSS/SCSS**: Indexed by rulesets, selectors, mixins

### Config Formats (NEW in v0.15.0)

- **JSON/YAML/TOML**: Indexed by top-level keys
- Large configs automatically split for better search granularity
```

### 14.3 AI Skill Documents (ai-skill.ts)

**Additions:**

```markdown
## NEW CAPABILITIES (v0.15.0)

### Document Search
- Markdown/RST/AsciiDoc/Org files indexed by headers
- Search by section name: "installation guide", "API reference"
- Parent sections tracked: e.g., "Setup > Prerequisites"

### Docstring Search
- JSDoc, Python docstrings, Rustdoc indexed separately
- Search for usage examples: "how to use authenticate()"
- Linked to parent symbols via metadata

### Web Languages
- HTML/CSS/SCSS now searchable
- Find styles: "primary button color"
- Find templates: "login form component"

### Shell Scripts
- Bash/Fish/Zsh function extraction
- Search deployment scripts: "deploy to production"

### Config Files
- JSON/YAML/TOML indexed by top-level keys
- Find settings: "database connection config"
```

---

## 15. Appendix A: Tree-sitter Queries

### A.1 HTML Chunk Query

```scheme
; Extract HTML elements as chunks
(element
  (start_tag
    (tag_name) @tag_name)
  (#match? @tag_name "^(section|article|div|header|footer|nav)$")) @chunk

; Script tags
(script_element) @chunk

; Style tags
(style_element) @chunk
```

### A.2 CSS Chunk Query

```scheme
; CSS rulesets
(rule_set
  (selectors) @name) @chunk

; Media queries
(media_statement
  (media_query_list)) @chunk

; Keyframe animations
(keyframes_statement
  (keyframes_name) @name) @chunk
```

### A.3 Bash Chunk Query

```scheme
; Function definitions
(function_definition
  name: (word) @name) @chunk

; Case statements (large switch blocks)
(case_statement) @chunk
```

### A.4 GraphQL Chunk Query

```scheme
; Type definitions
(type_definition
  (name) @name) @chunk

; Interface definitions
(interface_type_definition
  (name) @name) @chunk

; Query definitions
(operation_definition
  (name) @name) @chunk

; Mutation definitions
(mutation_definition
  (name) @name) @chunk
```

### A.5 YAML Chunk Query (if tree-sitter available)

```scheme
; Top-level keys
(block_mapping_pair
  key: (flow_node) @name) @chunk
```

### A.6 JSDoc Docstring Query

```scheme
; JSDoc comments preceding functions/classes
(comment) @docstring
(#match? @docstring "^/\\*\\*")

; Link to next sibling (function/class)
(function_declaration) @parent
(class_declaration) @parent
```

---

## 16. Appendix B: Regex Patterns

### B.1 Markdown Header Detection

```typescript
const markdownHeaderRegex = /^(#{1,6})\s+(.+)$/gm;

// Example match:
// Input: "## Installation Guide"
// Groups: ["##", "Installation Guide"]
// Level: 2
```

### B.2 RST Header Detection

```typescript
// RST uses underline style
const rstHeaderRegex = /^(.+)\n([=\-`:.'"~^_*+#]{3,})$/gm;

// Example match:
// Input:
//   Installation Guide
//   ==================
// Groups: ["Installation Guide", "=================="]
// Level: determined by underline character (= is h1, - is h2, etc.)
```

### B.3 AsciiDoc Header Detection

```typescript
const asciidocHeaderRegex = /^(={1,6})\s+(.+)$/gm;

// Example match:
// Input: "== Installation Guide"
// Groups: ["==", "Installation Guide"]
// Level: 2
```

### B.4 Org Mode Header Detection

```typescript
const orgHeaderRegex = /^(\*{1,6})\s+(.+)$/gm;

// Example match:
// Input: "** Installation Guide"
// Groups: ["**", "Installation Guide"]
// Level: 2
```

### B.5 Code Block Detection (All Formats)

```typescript
const codeBlockPatterns = {
  markdown: /```[\s\S]*?```/g,
  rst: /::[\s\S]*?(?=\n\S)/g,
  asciidoc: /----[\s\S]*?----/g,
  org: /#\+begin_src[\s\S]*?#\+end_src/gi,
};

// Usage: Skip header detection inside these blocks
```

---

## 17. Appendix C: File Size Estimates

### C.1 Grammar WASM Sizes

| Grammar | Approximate Size | Source |
|---------|------------------|--------|
| tree-sitter-html.wasm | ~200 KB | unpkg |
| tree-sitter-css.wasm | ~180 KB | unpkg |
| tree-sitter-scss.wasm | ~220 KB | unpkg |
| tree-sitter-bash.wasm | ~250 KB | unpkg |
| tree-sitter-fish.wasm | ~150 KB | npm |
| tree-sitter-json.wasm | ~100 KB | unpkg |
| tree-sitter-yaml.wasm | ~200 KB | unpkg |
| tree-sitter-toml.wasm | ~150 KB | unpkg |
| tree-sitter-graphql.wasm | ~180 KB | unpkg |
| **Total New Grammars** | **~1.6 MB** | |
| **Existing Grammars** | **~3.0 MB** | 10 languages |
| **Grand Total** | **~4.6 MB** | 18 languages |

**Distribution Impact:**
- npm package size increase: ~1.6 MB
- Acceptable for developer tool (within 5MB limit for many users)

---

## 18. Conclusion

This architecture provides a comprehensive, backward-compatible approach to extending claudemem with 18 new file types. Key strengths:

1. **Zero Breaking Changes**: Existing indexes and APIs work unchanged
2. **Modular Design**: New features isolated in separate modules
3. **Pragmatic Fallbacks**: Regex parsers for documents, grammar unavailability
4. **Comprehensive Testing**: Unit, integration, performance, edge case coverage
5. **Phased Implementation**: 7 weeks with clear dependencies and milestones

**Next Steps:**
1. Review architecture with team
2. Begin Phase 1 (Web Languages) implementation
3. Set up CI/CD for grammar downloads
4. Create test fixtures for all 18 new languages

**Risk Mitigation Summary:**
- Grammar unavailability: Regex fallbacks + source builds
- Performance: Lazy loading + benchmarking
- Accuracy: Comprehensive tests + user feedback loop
- Compatibility: Regression tests + zero schema changes

**Success Criteria Met When:**
- All 18 languages indexable
- <20% performance degradation
- >95% indexing success rate
- Documentation complete
- User validation positive

---

**Document Status:** Ready for Implementation
**Approval Required:** Development Team Lead
**Target Start Date:** Week of 2026-01-13
**Estimated Completion:** Week of 2026-02-24 (7 weeks)
