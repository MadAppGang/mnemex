/**
 * Symbol Extractor
 *
 * Extracts symbol definitions and references from source code using tree-sitter.
 * Builds on the existing parser-manager infrastructure.
 */

import { createHash } from "node:crypto";
import type { Node, Tree, QueryCapture } from "web-tree-sitter";
import { Query } from "web-tree-sitter";
import {
	getParserManager,
	type ParserManager,
} from "../parsers/parser-manager.js";
import type {
	SymbolDefinition,
	SymbolReference,
	SymbolKind,
	ReferenceKind,
	SupportedLanguage,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Map AST node types to symbol kinds */
const NODE_TYPE_TO_SYMBOL_KIND: Record<string, SymbolKind> = {
	// Functions
	function_declaration: "function",
	function_definition: "function",
	function_item: "function",
	arrow_function: "function",
	// Classes
	class_declaration: "class",
	class_definition: "class",
	class_specifier: "class",
	// Methods
	method_definition: "method",
	method_declaration: "method",
	// Types/Interfaces
	interface_declaration: "interface",
	type_alias_declaration: "type",
	// Enums
	enum_declaration: "enum",
	enum_item: "enum",
	enum_specifier: "enum",
	// Structs (C/C++/Rust/Go)
	struct_item: "struct",
	struct_specifier: "struct",
	type_declaration: "type", // Go type declarations
	// Rust-specific
	trait_item: "trait",
	impl_item: "impl",
};

/** Map capture name suffix to reference kind */
const CAPTURE_TO_REFERENCE_KIND: Record<string, ReferenceKind> = {
	call: "call",
	type: "type_usage",
	import: "import",
	extends: "extends",
	implements: "implements",
	field: "field_access",
};

// ============================================================================
// Symbol Extractor Class
// ============================================================================

export class SymbolExtractor {
	private parserManager: ParserManager;

	constructor() {
		this.parserManager = getParserManager();
	}

	/**
	 * Extract all symbols from a source file
	 */
	async extractSymbols(
		source: string,
		filePath: string,
		language: SupportedLanguage,
	): Promise<SymbolDefinition[]> {
		const tree = await this.parserManager.parse(source, language);
		if (!tree) {
			return [];
		}

		const symbols: SymbolDefinition[] = [];
		const sourceLines = source.split("\n");
		const now = new Date().toISOString();

		// Walk tree and extract symbols
		this.walkTree(tree.rootNode, (node) => {
			const kind = NODE_TYPE_TO_SYMBOL_KIND[node.type];
			if (!kind) {
				return true; // Continue traversing
			}

			// Extract symbol name
			const name = this.extractName(node, language);
			if (!name) {
				return true; // Skip anonymous symbols
			}

			// Check if exported
			const isExported = this.isExported(node, language);

			// Extract parent symbol ID (for methods)
			const parentId = this.extractParentId(node, filePath, language);

			// Extract signature
			const signature = this.extractSignature(node, source);

			// Extract docstring
			const docstring = this.extractDocstring(node, source);

			// Create symbol ID
			const id = this.createSymbolId(
				filePath,
				name,
				kind,
				node.startPosition.row + 1,
			);

			symbols.push({
				id,
				name,
				kind,
				filePath,
				startLine: node.startPosition.row + 1, // 1-indexed
				endLine: node.endPosition.row + 1,
				signature,
				docstring,
				parentId,
				isExported,
				language,
				pagerankScore: 0,
				createdAt: now,
				updatedAt: now,
			});

			// Don't traverse into nested definitions (we get them separately)
			return false;
		});

		return symbols;
	}

	/**
	 * Extract all references from a source file
	 */
	async extractReferences(
		source: string,
		filePath: string,
		language: SupportedLanguage,
		symbols: SymbolDefinition[],
	): Promise<SymbolReference[]> {
		const tree = await this.parserManager.parse(source, language);
		if (!tree) {
			return [];
		}

		const config = this.parserManager.getLanguageConfig(language);
		if (!config.referenceQuery) {
			return [];
		}

		const references: SymbolReference[] = [];
		const now = new Date().toISOString();

		// Build symbol map for finding enclosing symbols
		const symbolMap = new Map(symbols.map((s) => [s.id, s]));
		const symbolsByLine = this.buildSymbolLineIndex(symbols);

		try {
			// Get language object for query execution
			const lang = await this.parserManager.getLanguageObject(language);
			if (!lang) return [];

			const query = new Query(lang, config.referenceQuery);

			// Execute query
			const captures = query.captures(tree.rootNode);

			for (const capture of captures) {
				// Parse capture name to get reference kind
				const captureNameParts = capture.name.split(".");
				if (captureNameParts[0] !== "ref" || captureNameParts.length < 2) {
					continue;
				}

				const kindKey = captureNameParts[1];
				const kind = CAPTURE_TO_REFERENCE_KIND[kindKey];
				if (!kind) {
					continue;
				}

				const refName = capture.node.text;
				if (!refName || refName.length < 2) {
					continue; // Skip very short names
				}

				// Find enclosing symbol (the symbol making this reference)
				const line = capture.node.startPosition.row + 1;
				const enclosingSymbol = this.findEnclosingSymbol(line, symbolsByLine);

				// Skip if we can't find an enclosing symbol
				if (!enclosingSymbol) {
					continue;
				}

				references.push({
					fromSymbolId: enclosingSymbol.id,
					toSymbolName: refName,
					kind,
					filePath,
					line,
					isResolved: false,
					createdAt: now,
				});
			}
		} catch (error) {
			// Query parsing might fail for some edge cases, ignore
			console.warn(`Failed to extract references from ${filePath}:`, error);
		}

		// Deduplicate references (same symbol can be referenced multiple times)
		return this.deduplicateReferences(references);
	}

	/**
	 * Extract symbol name from AST node
	 */
	private extractName(
		node: Node,
		language: SupportedLanguage,
	): string | undefined {
		// Try direct children with common name patterns
		const namePatterns = ["name", "declarator"];

		for (const pattern of namePatterns) {
			const nameNode = node.childForFieldName(pattern);
			if (nameNode) {
				// Handle nested declarators (C/C++)
				if (nameNode.type === "function_declarator") {
					const innerDecl = nameNode.childForFieldName("declarator");
					if (innerDecl && innerDecl.type === "identifier") {
						return innerDecl.text;
					}
				}
				// Handle type_spec (Go)
				if (nameNode.type === "type_spec") {
					const typeName = nameNode.childForFieldName("name");
					if (typeName) {
						return typeName.text;
					}
				}
				// Direct identifier
				if (
					nameNode.type === "identifier" ||
					nameNode.type === "type_identifier" ||
					nameNode.type === "property_identifier" ||
					nameNode.type === "field_identifier"
				) {
					return nameNode.text;
				}
			}
		}

		// For arrow functions assigned to variables, get variable name
		if (node.type === "arrow_function") {
			const parent = node.parent;
			if (parent?.type === "variable_declarator") {
				const varName = parent.childForFieldName("name");
				if (varName?.type === "identifier") {
					return varName.text;
				}
			}
		}

		// For impl blocks in Rust, get type name
		if (node.type === "impl_item") {
			const typeNode = node.childForFieldName("type");
			if (typeNode?.type === "type_identifier") {
				return `impl_${typeNode.text}`;
			}
		}

		return undefined;
	}

	/**
	 * Check if symbol is exported/public
	 */
	private isExported(node: Node, language: SupportedLanguage): boolean {
		// Check parent for export statement (TypeScript/JavaScript)
		let current: Node | null = node;
		while (current) {
			if (
				current.type === "export_statement" ||
				current.type === "export_declaration"
			) {
				return true;
			}
			// Don't go too far up
			if (
				current.type === "program" ||
				current.type === "module" ||
				current.type === "source_file"
			) {
				break;
			}
			current = current.parent;
		}

		// Check for export keyword in node itself (some languages)
		const firstChild = node.child(0);
		if (firstChild?.text === "export" || firstChild?.text === "pub") {
			return true;
		}

		// Python: top-level functions/classes without underscore prefix are "public"
		if (language === "python") {
			const name = this.extractName(node, language);
			if (name && !name.startsWith("_")) {
				// Check if top-level
				const parent = node.parent;
				if (parent?.type === "module") {
					return true;
				}
			}
		}

		// Go: capitalized names are exported
		if (language === "go") {
			const name = this.extractName(node, language);
			if (name && name.length > 0 && name[0] === name[0].toUpperCase()) {
				return true;
			}
		}

		// Java: check for public modifier
		if (language === "java") {
			const modifiers = node.childForFieldName("modifiers");
			if (modifiers) {
				for (let i = 0; i < modifiers.childCount; i++) {
					const mod = modifiers.child(i);
					if (mod?.text === "public") {
						return true;
					}
				}
			}
		}

		// Default: assume not exported
		return false;
	}

	/**
	 * Extract parent symbol ID for methods
	 */
	private extractParentId(
		node: Node,
		filePath: string,
		language: SupportedLanguage,
	): string | undefined {
		// For methods, find enclosing class
		if (
			node.type === "method_definition" ||
			node.type === "method_declaration"
		) {
			let parent = node.parent;
			while (parent) {
				if (
					parent.type === "class_declaration" ||
					parent.type === "class_definition" ||
					parent.type === "class_body"
				) {
					// Get class name
					let classNode = parent;
					if (parent.type === "class_body") {
						classNode = parent.parent!;
					}
					const className = this.extractName(classNode, language);
					if (className) {
						return this.createSymbolId(
							filePath,
							className,
							"class",
							classNode.startPosition.row + 1,
						);
					}
				}
				parent = parent.parent;
			}
		}
		return undefined;
	}

	/**
	 * Extract function/class signature
	 */
	private extractSignature(node: Node, source: string): string | undefined {
		const startLine = node.startPosition.row;
		const lines = source.split("\n");
		let sig = lines[startLine];

		if (!sig) return undefined;

		// Clean up signature
		sig = sig.trim();

		// For multi-line signatures, get until opening brace or closing paren
		if (!sig.includes("{") && !sig.endsWith(")") && !sig.endsWith(":")) {
			for (
				let i = startLine + 1;
				i < Math.min(startLine + 5, lines.length);
				i++
			) {
				const nextLine = lines[i].trim();
				sig += " " + nextLine;
				if (sig.includes("{") || sig.endsWith(")") || sig.endsWith(":")) {
					break;
				}
			}
		}

		// Remove body, keep just signature
		const braceIndex = sig.indexOf("{");
		if (braceIndex > 0) {
			sig = sig.slice(0, braceIndex).trim();
		}

		// Remove trailing colon for Python
		if (sig.endsWith(":")) {
			sig = sig.slice(0, -1).trim();
		}

		return sig || undefined;
	}

	/**
	 * Extract docstring/JSDoc from preceding comments
	 */
	private extractDocstring(node: Node, source: string): string | undefined {
		const comments: string[] = [];
		let prev = node.previousNamedSibling;

		// Look backwards for comment nodes
		while (prev) {
			if (prev.type === "comment" || prev.type === "block_comment") {
				comments.unshift(prev.text);
				prev = prev.previousNamedSibling;
			} else {
				break;
			}
		}

		if (comments.length === 0) {
			return undefined;
		}

		// Parse and clean docstring
		let docstring = comments.join("\n");

		// Remove comment markers
		docstring = docstring
			.replace(/^\/\*\*?/gm, "") // Remove /** or /*
			.replace(/\*\/$/gm, "") // Remove */
			.replace(/^\s*\*\s?/gm, "") // Remove leading * in block comments
			.replace(/^\/\/\s?/gm, "") // Remove // for line comments
			.replace(/^#\s?/gm, "") // Remove # for Python comments
			.trim();

		return docstring || undefined;
	}

	/**
	 * Create unique symbol ID
	 */
	private createSymbolId(
		filePath: string,
		name: string,
		kind: SymbolKind,
		line: number,
	): string {
		const content = `${filePath}:${name}:${kind}:${line}`;
		return createHash("sha256").update(content).digest("hex").slice(0, 16);
	}

	/**
	 * Build index of symbols by line for fast lookup
	 */
	private buildSymbolLineIndex(
		symbols: SymbolDefinition[],
	): Map<number, SymbolDefinition[]> {
		const index = new Map<number, SymbolDefinition[]>();

		for (const symbol of symbols) {
			for (let line = symbol.startLine; line <= symbol.endLine; line++) {
				if (!index.has(line)) {
					index.set(line, []);
				}
				index.get(line)!.push(symbol);
			}
		}

		return index;
	}

	/**
	 * Find the innermost enclosing symbol for a line
	 */
	private findEnclosingSymbol(
		line: number,
		symbolsByLine: Map<number, SymbolDefinition[]>,
	): SymbolDefinition | undefined {
		const candidates = symbolsByLine.get(line);
		if (!candidates || candidates.length === 0) {
			return undefined;
		}

		// Return the smallest (most specific) symbol containing this line
		return candidates.reduce((smallest, current) => {
			const smallestSpan = smallest.endLine - smallest.startLine;
			const currentSpan = current.endLine - current.startLine;
			return currentSpan < smallestSpan ? current : smallest;
		});
	}

	/**
	 * Deduplicate references (keep first occurrence)
	 */
	private deduplicateReferences(refs: SymbolReference[]): SymbolReference[] {
		const seen = new Set<string>();
		const unique: SymbolReference[] = [];

		for (const ref of refs) {
			const key = `${ref.fromSymbolId}:${ref.toSymbolName}:${ref.kind}`;
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(ref);
			}
		}

		return unique;
	}

	/**
	 * Walk tree recursively
	 */
	private walkTree(node: Node, callback: (node: Node) => boolean): void {
		const shouldContinue = callback(node);
		if (shouldContinue) {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child) {
					this.walkTree(child, callback);
				}
			}
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a symbol extractor instance
 */
export function createSymbolExtractor(): SymbolExtractor {
	return new SymbolExtractor();
}
