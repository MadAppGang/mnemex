# Research: Tree-sitter Grammar Availability for Extended Language Support

**Date:** 2026-01-06
**Session:** dev-feature-extended-language-support-20260106-232702-7757d852
**Objective:** Determine availability of tree-sitter grammars for 14 target languages

---

## Executive Summary

Of the 14 target languages, **8 have ready-to-use npm packages with WASM support**, **6 require WASM builds from source or fallback parsers**, and **2 lack viable tree-sitter grammars**.

### Quick Status Matrix

| Language | Status | Package/Source |
|----------|--------|----------------|
| HTML | ✅ Ready | `tree-sitter-html` |
| CSS | ✅ Ready | `tree-sitter-css` |
| SCSS | ✅ Ready | `tree-sitter-scss` |
| Bash | ✅ Ready | `tree-sitter-bash` |
| JSON | ✅ Ready | `tree-sitter-json` |
| YAML | ✅ Ready | `tree-sitter-yaml` |
| TOML | ✅ Ready | `tree-sitter-toml` |
| GraphQL | ✅ Ready | `tree-sitter-graphql` |
| Markdown | ⚠️ Needs Build | `@tree-sitter-grammars/tree-sitter-markdown` |
| RST | ⚠️ Needs Build | GitHub source |
| Fish | ⚠️ Needs Build | `@esdmr/tree-sitter-fish` |
| Org | ⚠️ Needs Build | GitHub source |
| SASS | ❌ Use Fallback | Use SCSS grammar instead |
| AsciiDoc | ❌ Use Fallback | Rust crate only |

---

## Tier 1: Ready to Use (npm + WASM)

### 1. HTML
- **Package:** `tree-sitter-html`
- **Version:** v0.23.2
- **npm:** https://www.npmjs.com/package/tree-sitter-html
- **GitHub:** https://github.com/tree-sitter/tree-sitter-html
- **Status:** Official tree-sitter org, WASM included
- **Install:** `npm install tree-sitter-html`

### 2. CSS
- **Package:** `tree-sitter-css`
- **Version:** v0.25.0
- **npm:** https://www.npmjs.com/package/tree-sitter-css
- **GitHub:** https://github.com/tree-sitter/tree-sitter-css
- **Status:** Official tree-sitter org, WASM included
- **Install:** `npm install tree-sitter-css`

### 3. SCSS
- **Package:** `tree-sitter-scss`
- **Version:** v1.0.0
- **npm:** https://www.npmjs.com/package/tree-sitter-scss
- **GitHub:** https://github.com/tree-sitter-grammars/tree-sitter-scss
- **Status:** Community grammar, WASM included
- **Install:** `npm install tree-sitter-scss`

### 4. Bash
- **Package:** `tree-sitter-bash`
- **Version:** v0.25.1
- **npm:** https://www.npmjs.com/package/tree-sitter-bash
- **GitHub:** https://github.com/tree-sitter/tree-sitter-bash
- **Status:** Official tree-sitter org, WASM included
- **Notes:** Can also parse Zsh with some limitations
- **Install:** `npm install tree-sitter-bash`

### 5. JSON
- **Package:** `tree-sitter-json`
- **Version:** v0.24.8
- **npm:** https://www.npmjs.com/package/tree-sitter-json
- **GitHub:** https://github.com/tree-sitter/tree-sitter-json
- **Status:** Official tree-sitter org, WASM included
- **Install:** `npm install tree-sitter-json`

### 6. YAML
- **Package:** `tree-sitter-yaml` or `@tree-sitter-grammars/tree-sitter-yaml`
- **Version:** v0.5.0
- **npm:** https://www.npmjs.com/package/tree-sitter-yaml
- **GitHub:** https://github.com/ikatyang/tree-sitter-yaml
- **Status:** Stable, WASM included
- **Install:** `npm install tree-sitter-yaml`

### 7. TOML
- **Package:** `tree-sitter-toml` or `@tree-sitter-grammars/tree-sitter-toml`
- **Version:** v0.5.1
- **npm:** https://www.npmjs.com/package/tree-sitter-toml
- **GitHub:** https://github.com/ikatyang/tree-sitter-toml
- **Status:** Stable, WASM included
- **Install:** `npm install tree-sitter-toml`

### 8. GraphQL
- **Package:** `tree-sitter-graphql`
- **Version:** v1.0.0
- **npm:** https://www.npmjs.com/package/tree-sitter-graphql
- **GitHub:** https://github.com/bkegley/tree-sitter-graphql
- **Status:** Community grammar, WASM included
- **Install:** `npm install tree-sitter-graphql`

---

## Tier 2: Needs WASM Build

### 9. Markdown
- **Package:** `@tree-sitter-grammars/tree-sitter-markdown`
- **npm:** https://www.npmjs.com/package/@tree-sitter-grammars/tree-sitter-markdown
- **GitHub:** https://github.com/tree-sitter-grammars/tree-sitter-markdown
- **Status:** ⚠️ "Using this parser with WASM/web-tree-sitter does not work out of the box"
- **Issue:** Requires custom WASM build process
- **Options:**
  1. Build WASM ourselves using tree-sitter CLI
  2. Use pre-built from `tree-sitter-wasms` package
  3. Fallback to simple regex parser initially

### 10. reStructuredText (RST)
- **GitHub:** https://github.com/stsewd/tree-sitter-rst
- **Status:** Under active development, contains `tree-sitter-rst.wasm` in repo
- **npm:** Not published
- **Options:**
  1. Download WASM from GitHub releases
  2. Build from source
  3. Contact maintainer about npm publishing

### 11. Fish Shell
- **Package:** `@esdmr/tree-sitter-fish` (fork with WASM)
- **npm:** https://www.npmjs.com/package/@esdmr/tree-sitter-fish
- **Original GitHub:** https://github.com/ram02z/tree-sitter-fish
- **Status:** Community fork provides WASM
- **Install:** `npm install @esdmr/tree-sitter-fish`

### 12. Org Mode
- **GitHub:** https://github.com/milisims/tree-sitter-org
- **Status:** Active but not published to npm
- **npm:** Not available
- **Notes:** "Not meant to implement Emacs' orgmode parser exactly"
- **Options:**
  1. Build WASM from source
  2. Use fallback parser initially (limited userbase)

---

## Tier 3: Use Fallback Parser

### 13. SASS (Indented Syntax)
- **Status:** ❌ No dedicated tree-sitter grammar found
- **Recommendation:** Use `tree-sitter-scss` grammar or regex fallback
- **Rationale:** SCSS is superset of SASS, modern usage favors SCSS
- **Impact:** Low (most users use SCSS `.scss` not SASS `.sass`)

### 14. AsciiDoc
- **Rust Crate:** https://crates.io/crates/tree-sitter-asciidoc
- **npm:** Not available
- **Status:** ❌ Only available as Rust crate, would require WASM build from Rust
- **Recommendation:** Use fallback regex parser initially
- **Rationale:** Niche userbase, complex build process
- **Future:** Could build WASM if user demand exists

---

## Pre-built WASM Resources

### tree-sitter-wasms Package
- **npm:** https://www.npmjs.com/package/tree-sitter-wasms
- **Browse:** https://unpkg.com/browse/tree-sitter-wasms@latest/out/
- **Contains:** Many pre-built WASM grammars
- **Usage:** Backup source for grammars without official WASM

### VSCode Tree-sitter WASM
- **Package:** `@vscode/tree-sitter-wasm`
- **Contains:** VSCode's curated pre-built grammars
- **Quality:** High (used in production by millions)

---

## WASM Build Process

For grammars without pre-built WASM:

```bash
# Install dependencies
npm install --save-dev tree-sitter-cli tree-sitter-{language}

# Build WASM
npx tree-sitter build --wasm node_modules/tree-sitter-{language}

# Output: tree-sitter-{language}.wasm
```

**Alternative:** Use `tree-sitter-wasms` package as source:
```bash
npm install tree-sitter-wasms
# Copy from node_modules/tree-sitter-wasms/out/tree-sitter-{language}.wasm
```

---

## Implementation Recommendations

### Phase 1: Quick Wins (Tier 1)
Focus on 8 languages with ready-to-use packages:
- HTML, CSS, SCSS, Bash, JSON, YAML, TOML, GraphQL
- **Effort:** Low (npm install + basic language config)
- **Value:** High (covers most common config/web files)

### Phase 2: Build Required (Tier 2 - subset)
Add Markdown and Fish (high value, medium effort):
- Markdown: Use `tree-sitter-wasms` or build from source
- Fish: Use `@esdmr/tree-sitter-fish` package
- **Effort:** Medium (WASM build process)
- **Value:** High (Markdown very common, Fish growing popularity)

### Phase 3: Fallback First (Tier 3)
Implement regex-based fallback for:
- SASS (use SCSS grammar if possible)
- AsciiDoc (simple function/class detection)
- **Effort:** Low (regex patterns)
- **Value:** Medium (covers edge cases)

### Phase 4: Advanced (Tier 2 - remaining)
Add RST and Org if user demand exists:
- RST: Download WASM from GitHub
- Org: Build from source or skip (niche)
- **Effort:** High (custom builds)
- **Value:** Low (limited userbase)

---

## Testing Strategy

For each language:
1. **Grammar Loading:** Verify WASM loads without errors
2. **AST Parsing:** Parse sample files, validate syntax tree
3. **Symbol Extraction:** Test function/class/method detection
4. **Edge Cases:** Malformed syntax, mixed content (e.g., CSS in HTML)

---

## References

### Official Tree-sitter
- https://tree-sitter.github.io/tree-sitter/
- https://github.com/tree-sitter/tree-sitter

### Grammar Registry
- https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers

### WASM Resources
- https://www.npmjs.com/package/tree-sitter-wasms
- https://www.npmjs.com/package/@vscode/tree-sitter-wasm

---

## Conclusion

**Immediate Action:** Implement Tier 1 (8 languages) as they require zero WASM build effort and provide maximum coverage for common file types.

**Near-term:** Add Markdown (critical for docs) using `tree-sitter-wasms` package.

**Long-term:** Evaluate user feedback to prioritize Tier 2/3 languages.
