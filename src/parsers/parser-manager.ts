/**
 * Parser Manager for Tree-sitter
 *
 * Manages tree-sitter parsers and provides language detection
 * and parsing capabilities using WASM grammars.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Tree } from "web-tree-sitter";
import type { LanguageConfig, SupportedLanguage } from "../types.js";

// ============================================================================
// Language Configurations
// ============================================================================

const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
	typescript: {
		id: "typescript",
		extensions: [".ts", ".mts", ".cts"],
		grammarFile: "tree-sitter-typescript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (type_identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
      (interface_declaration
        name: (type_identifier) @name) @chunk
      (type_alias_declaration
        name: (type_identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function/method calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (member_expression
          property: (property_identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Import statements
      (import_specifier
        name: (identifier) @ref.import)
      (import_clause
        (identifier) @ref.import)
      ; Extends/implements
      (extends_clause
        value: (identifier) @ref.extends)
      (class_heritage
        (extends_clause
          (identifier) @ref.extends))
      (implements_clause
        (type_identifier) @ref.implements)
    `,
	},
	javascript: {
		id: "javascript",
		extensions: [".js", ".mjs", ".cjs"],
		grammarFile: "tree-sitter-javascript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
    `,
		referenceQuery: `
      ; Function/method calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (member_expression
          property: (property_identifier) @ref.call))
      ; Import statements
      (import_specifier
        name: (identifier) @ref.import)
      (import_clause
        (identifier) @ref.import)
      ; Extends clause
      (class_heritage
        (identifier) @ref.extends)
    `,
	},
	tsx: {
		id: "tsx",
		extensions: [".tsx"],
		grammarFile: "tree-sitter-tsx.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (type_identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
      (interface_declaration
        name: (type_identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function/method calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (member_expression
          property: (property_identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Import statements
      (import_specifier
        name: (identifier) @ref.import)
      (import_clause
        (identifier) @ref.import)
      ; Extends/implements
      (extends_clause
        value: (identifier) @ref.extends)
      (implements_clause
        (type_identifier) @ref.implements)
    `,
	},
	jsx: {
		id: "jsx",
		extensions: [".jsx"],
		grammarFile: "tree-sitter-javascript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
    `,
		referenceQuery: `
      ; Function/method calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (member_expression
          property: (property_identifier) @ref.call))
      ; Import statements
      (import_specifier
        name: (identifier) @ref.import)
      (import_clause
        (identifier) @ref.import)
      ; Extends clause
      (class_heritage
        (identifier) @ref.extends)
    `,
	},
	python: {
		id: "python",
		extensions: [".py", ".pyw", ".pyi"],
		grammarFile: "tree-sitter-python.wasm",
		chunkQuery: `
      (function_definition
        name: (identifier) @name) @chunk
      (class_definition
        name: (identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function calls
      (call
        function: (identifier) @ref.call)
      (call
        function: (attribute
          attribute: (identifier) @ref.call))
      ; Import statements - capture imported names
      (import_from_statement
        (dotted_name (identifier) @ref.import))
      (aliased_import
        (dotted_name (identifier) @ref.import))
      (import_statement
        (dotted_name (identifier) @ref.import))
      ; Class inheritance
      (class_definition
        superclasses: (argument_list
          (identifier) @ref.extends))
      ; Type annotations (Python 3.5+)
      (type
        (identifier) @ref.type)
    `,
	},
	go: {
		id: "go",
		extensions: [".go"],
		grammarFile: "tree-sitter-go.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (method_declaration
        name: (field_identifier) @name) @chunk
      (type_declaration
        (type_spec
          name: (type_identifier) @name)) @chunk
    `,
		referenceQuery: `
      ; Function calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (selector_expression
          field: (field_identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Qualified type references (package.Type)
      (qualified_type
        (package_identifier) @ref.import)
      ; Import statements
      (import_spec
        path: (interpreted_string_literal) @ref.import)
    `,
	},
	dingo: {
		id: "dingo",
		extensions: [".dingo"],
		grammarFile: "tree-sitter-dingo.wasm",
		chunkQuery: `
      ; Go-like constructs (Dingo uses identifier instead of field_identifier/type_identifier)
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

      ; Dingo-specific: let bindings
      (let_declaration
        name: (identifier) @name) @chunk

      ; Dingo-specific: lambda expressions
      (rust_style_lambda) @chunk
      (arrow_style_lambda) @chunk

      ; Dingo-specific: match expressions
      (match_expression) @chunk
    `,
		referenceQuery: `
      ; Function calls (Dingo uses identifier instead of field_identifier)
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (selector_expression
          field: (identifier) @ref.call))

      ; Qualified type references (package.Type)
      (qualified_type
        package: (identifier) @ref.import)

      ; Import statements
      (import_spec
        path: (interpreted_string_literal) @ref.import)

      ; Dingo-specific: enum variant references
      (variant_pattern
        type: (identifier) @ref.type)

      ; Dingo-specific: safe navigation references
      (safe_navigation
        field: (identifier) @ref.call)
    `,
	},
	rust: {
		id: "rust",
		extensions: [".rs"],
		grammarFile: "tree-sitter-rust.wasm",
		chunkQuery: `
      (function_item
        name: (identifier) @name) @chunk
      (impl_item) @chunk
      (struct_item
        name: (type_identifier) @name) @chunk
      (enum_item
        name: (type_identifier) @name) @chunk
      (trait_item
        name: (type_identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (scoped_identifier
          name: (identifier) @ref.call))
      (call_expression
        function: (field_expression
          field: (field_identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Use statements
      (use_declaration
        argument: (scoped_identifier) @ref.import)
      (use_declaration
        argument: (identifier) @ref.import)
      ; Trait bounds
      (trait_bounds
        (type_identifier) @ref.implements)
      ; Impl for type
      (impl_item
        trait: (type_identifier) @ref.implements)
    `,
	},
	c: {
		id: "c",
		extensions: [".c", ".h"],
		grammarFile: "tree-sitter-c.wasm",
		chunkQuery: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @name)) @chunk
      (struct_specifier
        name: (type_identifier) @name) @chunk
      (enum_specifier
        name: (type_identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (field_expression
          field: (field_identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Include statements
      (preproc_include
        path: (string_literal) @ref.import)
      (preproc_include
        path: (system_lib_string) @ref.import)
    `,
	},
	cpp: {
		id: "cpp",
		extensions: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"],
		grammarFile: "tree-sitter-cpp.wasm",
		chunkQuery: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @name)) @chunk
      (class_specifier
        name: (type_identifier) @name) @chunk
      (struct_specifier
        name: (type_identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Function calls
      (call_expression
        function: (identifier) @ref.call)
      (call_expression
        function: (field_expression
          field: (field_identifier) @ref.call))
      (call_expression
        function: (qualified_identifier
          name: (identifier) @ref.call))
      ; Type references
      (type_identifier) @ref.type
      ; Include statements
      (preproc_include
        path: (string_literal) @ref.import)
      (preproc_include
        path: (system_lib_string) @ref.import)
      ; Base class specifier
      (base_class_clause
        (type_identifier) @ref.extends)
    `,
	},
	java: {
		id: "java",
		extensions: [".java"],
		grammarFile: "tree-sitter-java.wasm",
		chunkQuery: `
      (method_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (interface_declaration
        name: (identifier) @name) @chunk
      (enum_declaration
        name: (identifier) @name) @chunk
    `,
		referenceQuery: `
      ; Method calls
      (method_invocation
        name: (identifier) @ref.call)
      (method_invocation
        object: (identifier) @ref.call)
      ; Type references
      (type_identifier) @ref.type
      ; Import statements
      (import_declaration
        (scoped_identifier) @ref.import)
      ; Extends clause
      (superclass
        (type_identifier) @ref.extends)
      ; Implements clause
      (super_interfaces
        (type_list
          (type_identifier) @ref.implements))
    `,
	},
	html: {
		id: "html",
		extensions: [".html", ".htm"],
		grammarFile: "tree-sitter-html.wasm",
		chunkQuery: `
      ; Extract HTML elements as chunks
      (element
        (start_tag
          (tag_name) @tag_name)
        (#match? @tag_name "^(section|article|div|header|footer|nav|main|aside)$")) @chunk
      ; Script tags
      (script_element) @chunk
      ; Style tags
      (style_element) @chunk
    `,
		referenceQuery: `
      ; Class references in attributes
      (attribute
        (attribute_name) @attr (#eq? @attr "class")
        (quoted_attribute_value) @ref.class)
      ; ID references
      (attribute
        (attribute_name) @attr (#eq? @attr "id")
        (quoted_attribute_value) @ref.id)
    `,
	},
	css: {
		id: "css",
		extensions: [".css"],
		grammarFile: "tree-sitter-css.wasm",
		chunkQuery: `
      ; CSS rulesets
      (rule_set
        (selectors) @name) @chunk
      ; Media queries
      (media_statement) @chunk
      ; Keyframe animations
      (keyframes_statement
        (keyframes_name) @name) @chunk
    `,
		referenceQuery: `
      ; No references tracked for CSS (no call relationships)
    `,
	},
	scss: {
		id: "scss",
		extensions: [".scss", ".sass"],
		grammarFile: "tree-sitter-scss.wasm",
		chunkQuery: `
      ; SCSS rulesets
      (rule_set
        (selectors) @name) @chunk
      ; Mixins
      (mixin_statement
        (name) @name) @chunk
      ; Functions
      (function_statement
        (name) @name) @chunk
      ; Media queries
      (media_statement) @chunk
    `,
		referenceQuery: `
      ; Mixin includes
      (include_statement
        (identifier) @ref.call)
    `,
	},
	bash: {
		id: "bash",
		extensions: [".sh", ".bash"],
		grammarFile: "tree-sitter-bash.wasm",
		chunkQuery: `
      ; Function definitions
      (function_definition
        name: (word) @name) @chunk
    `,
		referenceQuery: `
      ; Command calls
      (command
        name: (command_name) @ref.call)
    `,
	},
	zsh: {
		id: "zsh",
		extensions: [".zsh"],
		grammarFile: "tree-sitter-bash.wasm", // Zsh uses bash grammar
		chunkQuery: `
      ; Function definitions
      (function_definition
        name: (word) @name) @chunk
    `,
		referenceQuery: `
      ; Command calls
      (command
        name: (command_name) @ref.call)
    `,
	},
	fish: {
		id: "fish",
		extensions: [".fish"],
		grammarFile: "tree-sitter-fish.wasm",
		chunkQuery: `
      ; Function definitions
      (function_definition
        (word) @name) @chunk
    `,
		referenceQuery: `
      ; Command calls
      (command
        (word) @ref.call)
    `,
	},
	graphql: {
		id: "graphql",
		extensions: [".graphql", ".gql"],
		grammarFile: "tree-sitter-graphql.wasm",
		chunkQuery: `
      ; Type definitions
      (object_type_definition
        (name) @name) @chunk
      ; Interface definitions
      (interface_type_definition
        (name) @name) @chunk
      ; Enum definitions
      (enum_type_definition
        (name) @name) @chunk
      ; Input type definitions
      (input_object_type_definition
        (name) @name) @chunk
      ; Operation definitions (queries, mutations, subscriptions)
      (operation_definition
        (name) @name) @chunk
      ; Fragment definitions
      (fragment_definition
        (fragment_name) @name) @chunk
    `,
		referenceQuery: `
      ; Type references
      (named_type
        (name) @ref.type)
      ; Fragment spreads
      (fragment_spread
        (fragment_name) @ref.call)
    `,
	},
	json: {
		id: "json",
		extensions: [".json"],
		grammarFile: "tree-sitter-json.wasm",
		chunkQuery: `
      ; Top-level objects and arrays
      (pair
        key: (string) @name) @chunk
    `,
		referenceQuery: `
      ; No references tracked for JSON
    `,
	},
	yaml: {
		id: "yaml",
		extensions: [".yaml", ".yml"],
		grammarFile: "tree-sitter-yaml.wasm",
		chunkQuery: `
      ; Top-level mappings
      (block_mapping_pair
        key: (flow_node) @name) @chunk
    `,
		referenceQuery: `
      ; No references tracked for YAML
    `,
	},
	toml: {
		id: "toml",
		extensions: [".toml"],
		grammarFile: "tree-sitter-toml.wasm",
		chunkQuery: `
      ; Top-level tables
      (table
        (dotted_key) @name) @chunk
      ; Array of tables
      (table_array_element
        (dotted_key) @name) @chunk
    `,
		referenceQuery: `
      ; No references tracked for TOML
    `,
	},
	markdown: {
		id: "markdown",
		extensions: [".md", ".markdown"],
		grammarFile: "tree-sitter-markdown.wasm",
		chunkQuery: `
      ; Header-based chunking handled by document-chunker.ts
      ; This query is used as fallback if document chunker is unavailable
      (atx_heading) @chunk
      (setext_heading) @chunk
    `,
		referenceQuery: `
      ; No references tracked for Markdown
    `,
	},
	rst: {
		id: "rst",
		extensions: [".rst"],
		grammarFile: "tree-sitter-rst.wasm",
		chunkQuery: `
      ; Header-based chunking handled by document-chunker.ts
      ; Fallback to full-file chunk if tree-sitter unavailable
    `,
		referenceQuery: `
      ; No references tracked for RST
    `,
	},
	asciidoc: {
		id: "asciidoc",
		extensions: [".adoc", ".asciidoc"],
		grammarFile: "tree-sitter-asciidoc.wasm",
		chunkQuery: `
      ; Header-based chunking handled by document-chunker.ts
      ; Fallback to full-file chunk if tree-sitter unavailable
    `,
		referenceQuery: `
      ; No references tracked for AsciiDoc
    `,
	},
	org: {
		id: "org",
		extensions: [".org"],
		grammarFile: "tree-sitter-org.wasm",
		chunkQuery: `
      ; Header-based chunking handled by document-chunker.ts
      ; Fallback to full-file chunk if tree-sitter unavailable
    `,
		referenceQuery: `
      ; No references tracked for Org
    `,
	},
};

// ============================================================================
// Extension to Language Mapping
// ============================================================================

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {};

for (const [language, config] of Object.entries(LANGUAGE_CONFIGS)) {
	for (const ext of config.extensions) {
		EXTENSION_TO_LANGUAGE[ext] = language as SupportedLanguage;
	}
}

// ============================================================================
// Parser Manager Class
// ============================================================================

export class ParserManager {
	private initialized = false;
	private parsers: Map<SupportedLanguage, Parser> = new Map();
	private languages: Map<SupportedLanguage, Language> = new Map();
	private grammarsPath: string;

	constructor(grammarsPath?: string) {
		// Default to grammars directory relative to this file
		// In development: src/parsers/parser-manager.ts -> ../../grammars
		// In bundled dist: dist/index.js -> ../grammars
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const isDist = __dirname.includes("/dist") || __dirname.endsWith("/dist/");
		const relativePath = isDist ? "../grammars" : "../../grammars";
		this.grammarsPath = grammarsPath || join(__dirname, relativePath);
	}

	/**
	 * Initialize the parser manager
	 * Must be called before parsing any files
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		// Use locateFile to tell web-tree-sitter where to find tree-sitter.wasm
		// This is critical for bundled distributions where the default path
		// gets baked in at build time (e.g., GitHub Actions path)
		await Parser.init({
			locateFile: (scriptName: string) => {
				// Return the path to tree-sitter.wasm in our grammars directory
				return join(this.grammarsPath, scriptName);
			},
		});
		this.initialized = true;
	}

	/**
	 * Get the language for a file path
	 */
	getLanguage(filePath: string): SupportedLanguage | null {
		const ext = extname(filePath).toLowerCase();
		return EXTENSION_TO_LANGUAGE[ext] || null;
	}

	/**
	 * Check if a file is supported
	 */
	isSupported(filePath: string): boolean {
		return this.getLanguage(filePath) !== null;
	}

	/**
	 * Get the configuration for a language
	 */
	getLanguageConfig(language: SupportedLanguage): LanguageConfig {
		return LANGUAGE_CONFIGS[language];
	}

	/**
	 * Get a parser for a specific language
	 */
	async getParser(language: SupportedLanguage): Promise<Parser | null> {
		await this.initialize();

		// Return cached parser if available
		if (this.parsers.has(language)) {
			return this.parsers.get(language)!;
		}

		// Load the language
		const lang = await this.loadLanguage(language);
		if (!lang) {
			return null;
		}

		// Create parser
		const parser = new Parser();
		parser.setLanguage(lang);

		// Cache it
		this.parsers.set(language, parser);
		return parser;
	}

	/**
	 * Get a Language object for query execution
	 * This is needed because web-tree-sitter Parser doesn't expose its Language
	 */
	async getLanguageObject(
		language: SupportedLanguage,
	): Promise<Language | null> {
		return this.loadLanguage(language);
	}

	/**
	 * Load a language grammar
	 */
	private async loadLanguage(
		language: SupportedLanguage,
	): Promise<Language | null> {
		// Return cached language if available
		if (this.languages.has(language)) {
			return this.languages.get(language)!;
		}

		const config = LANGUAGE_CONFIGS[language];
		const grammarPath = join(this.grammarsPath, config.grammarFile);

		// Check if grammar file exists
		if (!existsSync(grammarPath)) {
			console.warn(`Grammar file not found: ${grammarPath}`);
			return null;
		}

		try {
			const wasmBuffer = readFileSync(grammarPath);
			const lang = await Language.load(wasmBuffer);

			// Cache it
			this.languages.set(language, lang);
			return lang;
		} catch (error) {
			console.error(`Failed to load grammar for ${language}:`, error);
			return null;
		}
	}

	/**
	 * Parse source code
	 */
	async parse(
		source: string,
		language: SupportedLanguage,
	): Promise<Tree | null> {
		const parser = await this.getParser(language);
		if (!parser) {
			return null;
		}

		return parser.parse(source);
	}

	/**
	 * Get supported languages
	 */
	getSupportedLanguages(): SupportedLanguage[] {
		return Object.keys(LANGUAGE_CONFIGS) as SupportedLanguage[];
	}

	/**
	 * Get supported extensions
	 */
	getSupportedExtensions(): string[] {
		return Object.keys(EXTENSION_TO_LANGUAGE);
	}
}

// ============================================================================
// Singleton Instance
// ============================================================================

let parserManagerInstance: ParserManager | null = null;

/**
 * Get the singleton parser manager instance
 */
export function getParserManager(): ParserManager {
	if (!parserManagerInstance) {
		parserManagerInstance = new ParserManager();
	}
	return parserManagerInstance;
}

/**
 * Set a custom grammars path
 */
export function setGrammarsPath(path: string): void {
	parserManagerInstance = new ParserManager(path);
}
