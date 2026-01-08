/**
 * AST Metadata Extractor
 *
 * Extracts rich metadata from AST nodes including:
 * - Visibility (public/private/protected/exported)
 * - Async/generator/static flags
 * - Parameters with types
 * - Return types
 * - Imports used, functions called, types referenced
 * - Decorators and docstrings
 */

import type { Node } from "web-tree-sitter";
import { Query } from "web-tree-sitter";
import {
	getParserManager,
	type ParserManager,
} from "../../parsers/parser-manager.js";
import type {
	ASTMetadata,
	SupportedLanguage,
	Visibility,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface ExtractionContext {
	filePath: string;
	source: string;
	language: SupportedLanguage;
}

// ============================================================================
// Constants
// ============================================================================

/** Node types that represent function-like constructs */
const FUNCTION_NODE_TYPES = new Set([
	"function_declaration",
	"function_definition",
	"function_item",
	"arrow_function",
	"method_definition",
	"method_declaration",
	"function_expression",
]);

/** Node types that represent class-like constructs */
const CLASS_NODE_TYPES = new Set([
	"class_declaration",
	"class_definition",
	"class_specifier",
	"interface_declaration",
	"struct_item",
	"struct_specifier",
	"trait_item",
	"enum_declaration",
	"enum_item",
]);

/** Node types representing async markers by language */
const ASYNC_MARKERS: Record<string, Set<string>> = {
	typescript: new Set(["async"]),
	javascript: new Set(["async"]),
	python: new Set(["async"]),
	rust: new Set(["async"]),
};

// ============================================================================
// AST Metadata Extractor Class
// ============================================================================

export class ASTMetadataExtractor {
	private parserManager: ParserManager;

	constructor() {
		this.parserManager = getParserManager();
	}

	/**
	 * Extract comprehensive metadata from an AST node
	 */
	extractMetadata(node: Node, ctx: ExtractionContext): ASTMetadata {
		const metadata: ASTMetadata = {};

		// Extract visibility
		const visibility = this.extractVisibility(node, ctx.language);
		if (visibility) metadata.visibility = visibility;

		// Extract async/generator/static flags
		if (this.isAsync(node, ctx.language)) metadata.isAsync = true;
		if (this.isGenerator(node)) metadata.isGenerator = true;
		if (this.isStatic(node)) metadata.isStatic = true;

		// Extract export status
		if (this.isExported(node, ctx.language)) metadata.isExported = true;

		// Extract decorators
		const decorators = this.extractDecorators(node, ctx.language);
		if (decorators.length > 0) metadata.decorators = decorators;

		// Extract parameters and return type for functions
		if (FUNCTION_NODE_TYPES.has(node.type)) {
			const params = this.extractParameters(node, ctx.language);
			if (params.length > 0) metadata.parameters = params;

			const returnType = this.extractReturnType(node, ctx.language);
			if (returnType) metadata.returnType = returnType;
		}

		// Extract type parameters (generics)
		const typeParams = this.extractTypeParameters(node, ctx.language);
		if (typeParams.length > 0) metadata.typeParameters = typeParams;

		// Extract receiver (Go methods, Rust impl methods)
		const receiver = this.extractReceiver(node, ctx.language);
		if (receiver) metadata.receiver = receiver;

		// Extract docstring
		const docstring = this.extractDocstring(node, ctx.source);
		if (docstring) metadata.docstring = docstring;

		// Extract references (imports, function calls, types)
		const refs = this.extractReferences(node, ctx);
		if (refs.importsUsed.length > 0) metadata.importsUsed = refs.importsUsed;
		if (refs.functionsCalled.length > 0)
			metadata.functionsCalled = refs.functionsCalled;
		if (refs.typesReferenced.length > 0)
			metadata.typesReferenced = refs.typesReferenced;

		return metadata;
	}

	/**
	 * Extract visibility modifier
	 */
	private extractVisibility(
		node: Node,
		language: SupportedLanguage,
	): Visibility | undefined {
		// TypeScript/JavaScript: check for export
		if (language === "typescript" || language === "javascript") {
			if (this.isExported(node, language)) {
				return "exported";
			}
			// Check for private/protected in class members
			const accessModifier = this.findAccessModifier(node);
			if (accessModifier) return accessModifier;
		}

		// Python: underscore convention
		if (language === "python") {
			const name = this.extractNameFromNode(node);
			if (name?.startsWith("__") && name.endsWith("__")) {
				return "public"; // Dunder methods are public
			}
			if (name?.startsWith("__")) return "private";
			if (name?.startsWith("_")) return "protected";
			return "public";
		}

		// Go: capitalization convention
		if (language === "go") {
			const name = this.extractNameFromNode(node);
			if (name && name.length > 0) {
				return name[0] === name[0].toUpperCase() ? "exported" : "internal";
			}
		}

		// Java: explicit modifiers
		if (language === "java") {
			const modifiers = node.childForFieldName("modifiers");
			if (modifiers) {
				for (let i = 0; i < modifiers.childCount; i++) {
					const mod = modifiers.child(i)?.text;
					if (mod === "public") return "public";
					if (mod === "private") return "private";
					if (mod === "protected") return "protected";
				}
			}
			return "internal"; // package-private default
		}

		// Rust: pub keyword
		if (language === "rust") {
			const firstChild = node.child(0);
			if (firstChild?.text === "pub") return "public";
			return "private";
		}

		return undefined;
	}

	/**
	 * Find access modifier in TypeScript class members
	 */
	private findAccessModifier(node: Node): Visibility | undefined {
		// Check for accessibility modifier in method/property
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child?.type === "accessibility_modifier") {
				const text = child.text;
				if (text === "private") return "private";
				if (text === "protected") return "protected";
				if (text === "public") return "public";
			}
		}
		return undefined;
	}

	/**
	 * Check if node represents an async function
	 */
	private isAsync(node: Node, language: SupportedLanguage): boolean {
		const markers = ASYNC_MARKERS[language];
		if (!markers) return false;

		// Check first children for async keyword
		for (let i = 0; i < Math.min(3, node.childCount); i++) {
			const child = node.child(i);
			if (child && markers.has(child.text)) {
				return true;
			}
		}

		// Python: check parent for async_function_definition
		if (
			language === "python" &&
			node.parent?.type === "async_function_definition"
		) {
			return true;
		}

		return false;
	}

	/**
	 * Check if node represents a generator function
	 */
	private isGenerator(node: Node): boolean {
		// JavaScript/TypeScript: function* syntax
		for (let i = 0; i < Math.min(5, node.childCount); i++) {
			const child = node.child(i);
			if (child?.text === "*") return true;
		}

		// Python: check for yield in body (simplified check)
		if (node.type === "function_definition") {
			const body = node.childForFieldName("body");
			if (body?.text.includes("yield")) return true;
		}

		return false;
	}

	/**
	 * Check if node represents a static method/property
	 */
	private isStatic(node: Node): boolean {
		for (let i = 0; i < Math.min(3, node.childCount); i++) {
			const child = node.child(i);
			if (child?.text === "static") return true;
		}
		return false;
	}

	/**
	 * Check if symbol is exported
	 */
	private isExported(node: Node, language: SupportedLanguage): boolean {
		// Check parent for export statement
		let current: Node | null = node;
		while (current) {
			if (
				current.type === "export_statement" ||
				current.type === "export_declaration"
			) {
				return true;
			}
			if (
				current.type === "program" ||
				current.type === "module" ||
				current.type === "source_file"
			) {
				break;
			}
			current = current.parent;
		}

		// Check for export keyword in node itself
		const firstChild = node.child(0);
		if (firstChild?.text === "export" || firstChild?.text === "pub") {
			return true;
		}

		// Python: top-level non-underscore names
		if (language === "python") {
			const name = this.extractNameFromNode(node);
			if (name && !name.startsWith("_")) {
				const parent = node.parent;
				if (parent?.type === "module") return true;
			}
		}

		// Go: capitalized names
		if (language === "go") {
			const name = this.extractNameFromNode(node);
			if (name && name.length > 0 && name[0] === name[0].toUpperCase()) {
				return true;
			}
		}

		// Java: public modifier
		if (language === "java") {
			const modifiers = node.childForFieldName("modifiers");
			if (modifiers) {
				for (let i = 0; i < modifiers.childCount; i++) {
					if (modifiers.child(i)?.text === "public") return true;
				}
			}
		}

		return false;
	}

	/**
	 * Extract decorators/attributes
	 */
	private extractDecorators(node: Node, language: SupportedLanguage): string[] {
		const decorators: string[] = [];

		// Python: decorator nodes
		if (language === "python") {
			let prev = node.previousNamedSibling;
			while (prev?.type === "decorator") {
				decorators.unshift(prev.text.replace(/^@/, ""));
				prev = prev.previousNamedSibling;
			}
		}

		// TypeScript/JavaScript: decorator nodes
		if (language === "typescript" || language === "javascript") {
			let prev = node.previousNamedSibling;
			while (prev?.type === "decorator") {
				decorators.unshift(prev.text.replace(/^@/, ""));
				prev = prev.previousNamedSibling;
			}
		}

		// Rust: attribute nodes
		if (language === "rust") {
			let prev = node.previousNamedSibling;
			while (prev?.type === "attribute_item") {
				decorators.unshift(prev.text.replace(/^#\[|\]$/g, ""));
				prev = prev.previousNamedSibling;
			}
		}

		// Java: annotations
		if (language === "java") {
			const modifiers = node.childForFieldName("modifiers");
			if (modifiers) {
				for (let i = 0; i < modifiers.childCount; i++) {
					const child = modifiers.child(i);
					if (
						child?.type === "marker_annotation" ||
						child?.type === "annotation"
					) {
						decorators.push(child.text.replace(/^@/, ""));
					}
				}
			}
		}

		return decorators;
	}

	/**
	 * Extract function parameters with types
	 */
	private extractParameters(
		node: Node,
		language: SupportedLanguage,
	): Array<{ name: string; type?: string }> {
		const params: Array<{ name: string; type?: string }> = [];

		// Find parameters node
		const paramsNode =
			node.childForFieldName("parameters") ||
			node.childForFieldName("formal_parameters");
		if (!paramsNode) return params;

		// Walk parameter children
		for (let i = 0; i < paramsNode.namedChildCount; i++) {
			const param = paramsNode.namedChild(i);
			if (!param) continue;

			const paramInfo = this.extractParamInfo(param, language);
			if (paramInfo) params.push(paramInfo);
		}

		return params;
	}

	/**
	 * Extract single parameter info
	 */
	private extractParamInfo(
		param: Node,
		language: SupportedLanguage,
	): { name: string; type?: string } | null {
		// TypeScript/JavaScript
		if (language === "typescript" || language === "javascript") {
			// Required/optional parameter
			if (
				param.type === "required_parameter" ||
				param.type === "optional_parameter"
			) {
				const pattern = param.childForFieldName("pattern");
				const typeNode = param.childForFieldName("type");
				const name = pattern?.text || param.childForFieldName("name")?.text;
				if (name) {
					return { name, type: typeNode?.text };
				}
			}
			// Simple identifier
			if (param.type === "identifier") {
				return { name: param.text };
			}
		}

		// Python
		if (language === "python") {
			if (param.type === "identifier") {
				return { name: param.text };
			}
			if (param.type === "typed_parameter") {
				const name = param.childForFieldName("name")?.text;
				const type = param.childForFieldName("type")?.text;
				if (name) return { name, type };
			}
			if (param.type === "default_parameter") {
				const name = param.childForFieldName("name")?.text;
				if (name) return { name };
			}
		}

		// Go
		if (language === "go") {
			if (param.type === "parameter_declaration") {
				const name = param.childForFieldName("name")?.text;
				const type = param.childForFieldName("type")?.text;
				if (name) return { name, type };
			}
		}

		// Java
		if (language === "java") {
			if (param.type === "formal_parameter") {
				const name = param.childForFieldName("name")?.text;
				const type = param.childForFieldName("type")?.text;
				if (name) return { name, type };
			}
		}

		// Rust
		if (language === "rust") {
			if (param.type === "parameter") {
				const pattern = param.childForFieldName("pattern")?.text;
				const type = param.childForFieldName("type")?.text;
				if (pattern) return { name: pattern, type };
			}
		}

		return null;
	}

	/**
	 * Extract return type annotation
	 */
	private extractReturnType(
		node: Node,
		language: SupportedLanguage,
	): string | undefined {
		// TypeScript/JavaScript
		if (language === "typescript" || language === "javascript") {
			const returnType = node.childForFieldName("return_type");
			if (returnType) return returnType.text.replace(/^:\s*/, "");
		}

		// Python
		if (language === "python") {
			const returnType = node.childForFieldName("return_type");
			if (returnType) return returnType.text.replace(/^->\s*/, "");
		}

		// Go
		if (language === "go") {
			const result = node.childForFieldName("result");
			if (result) return result.text;
		}

		// Java
		if (language === "java") {
			const type = node.childForFieldName("type");
			if (type) return type.text;
		}

		// Rust
		if (language === "rust") {
			const returnType = node.childForFieldName("return_type");
			if (returnType) return returnType.text.replace(/^->\s*/, "");
		}

		return undefined;
	}

	/**
	 * Extract type parameters (generics)
	 */
	private extractTypeParameters(
		node: Node,
		language: SupportedLanguage,
	): string[] {
		const typeParams: string[] = [];

		// TypeScript/JavaScript
		if (language === "typescript") {
			const typeParamsNode = node.childForFieldName("type_parameters");
			if (typeParamsNode) {
				for (let i = 0; i < typeParamsNode.namedChildCount; i++) {
					const param = typeParamsNode.namedChild(i);
					if (param?.type === "type_parameter") {
						typeParams.push(param.text);
					}
				}
			}
		}

		// Java
		if (language === "java") {
			const typeParamsNode = node.childForFieldName("type_parameters");
			if (typeParamsNode) {
				for (let i = 0; i < typeParamsNode.namedChildCount; i++) {
					const param = typeParamsNode.namedChild(i);
					if (param?.type === "type_parameter") {
						typeParams.push(param.text);
					}
				}
			}
		}

		// Rust
		if (language === "rust") {
			const typeParamsNode = node.childForFieldName("type_parameters");
			if (typeParamsNode) {
				for (let i = 0; i < typeParamsNode.namedChildCount; i++) {
					const param = typeParamsNode.namedChild(i);
					if (
						param?.type === "type_identifier" ||
						param?.type === "constrained_type_parameter"
					) {
						typeParams.push(param.text);
					}
				}
			}
		}

		// Go: type parameters in square brackets (Go 1.18+)
		if (language === "go") {
			const typeParamsNode = node.childForFieldName("type_parameters");
			if (typeParamsNode) {
				for (let i = 0; i < typeParamsNode.namedChildCount; i++) {
					const param = typeParamsNode.namedChild(i);
					typeParams.push(param?.text || "");
				}
			}
		}

		return typeParams.filter(Boolean);
	}

	/**
	 * Extract receiver (Go methods, Rust impl methods)
	 */
	private extractReceiver(
		node: Node,
		language: SupportedLanguage,
	): string | undefined {
		// Go: receiver parameter
		if (language === "go" && node.type === "method_declaration") {
			const receiver = node.childForFieldName("receiver");
			if (receiver) {
				// Extract type from receiver
				const paramList = receiver.namedChild(0);
				if (paramList) {
					const type = paramList.childForFieldName("type");
					if (type) return type.text;
				}
			}
		}

		// Rust: look for self in impl block context
		if (language === "rust" && node.type === "function_item") {
			const params = node.childForFieldName("parameters");
			if (params?.namedChildCount && params.namedChildCount > 0) {
				const firstParam = params.namedChild(0);
				if (firstParam?.type === "self_parameter") {
					// Get impl type from parent
					let parent = node.parent;
					while (parent) {
						if (parent.type === "impl_item") {
							const implType = parent.childForFieldName("type");
							if (implType) return implType.text;
						}
						parent = parent.parent;
					}
				}
			}
		}

		return undefined;
	}

	/**
	 * Extract docstring from preceding comments
	 */
	private extractDocstring(node: Node, source: string): string | undefined {
		const comments: string[] = [];
		let prev = node.previousNamedSibling;

		// Look backwards for comment nodes
		while (prev) {
			if (prev.type === "comment" || prev.type === "block_comment") {
				comments.unshift(prev.text);
				prev = prev.previousNamedSibling;
			} else if (prev.type === "decorator" || prev.type === "attribute_item") {
				// Skip decorators/attributes
				prev = prev.previousNamedSibling;
			} else {
				break;
			}
		}

		if (comments.length === 0) return undefined;

		// Parse and clean docstring
		let docstring = comments.join("\n");

		// Remove comment markers
		docstring = docstring
			.replace(/^\/\*\*?/gm, "") // Remove /** or /*
			.replace(/\*\/$/gm, "") // Remove */
			.replace(/^\s*\*\s?/gm, "") // Remove leading * in block comments
			.replace(/^\/\/\s?/gm, "") // Remove // for line comments
			.replace(/^#\s?/gm, "") // Remove # for Python comments
			.replace(/^"""/gm, "") // Remove """ for Python docstrings
			.replace(/"""$/gm, "")
			.trim();

		return docstring || undefined;
	}

	/**
	 * Extract references (imports, function calls, type references)
	 */
	private extractReferences(
		node: Node,
		ctx: ExtractionContext,
	): {
		importsUsed: string[];
		functionsCalled: string[];
		typesReferenced: string[];
	} {
		const importsUsed = new Set<string>();
		const functionsCalled = new Set<string>();
		const typesReferenced = new Set<string>();

		// Walk the node tree to find references
		this.walkNode(node, (child) => {
			// Function calls
			if (child.type === "call_expression") {
				const func = child.childForFieldName("function");
				if (func) {
					const name = this.extractCallName(func);
					if (name && name.length > 1) functionsCalled.add(name);
				}
			}

			// Type references (TypeScript/Java)
			if (
				child.type === "type_identifier" ||
				child.type === "type_annotation"
			) {
				const name = child.text.replace(/^:\s*/, "").split(/[<\[\(]/)[0];
				if (name && name.length > 1 && /^[A-Z]/.test(name)) {
					typesReferenced.add(name);
				}
			}

			// Import tracking - collect names from import statements
			if (
				child.type === "import_statement" ||
				child.type === "import_declaration"
			) {
				const names = this.extractImportNames(child);
				for (const name of names) importsUsed.add(name);
			}

			return true; // Continue traversal
		});

		return {
			importsUsed: Array.from(importsUsed),
			functionsCalled: Array.from(functionsCalled),
			typesReferenced: Array.from(typesReferenced),
		};
	}

	/**
	 * Extract function name from call expression
	 */
	private extractCallName(node: Node): string | undefined {
		// Direct identifier
		if (node.type === "identifier") {
			return node.text;
		}

		// Member expression: obj.method
		if (
			node.type === "member_expression" ||
			node.type === "property_access_expression"
		) {
			const property =
				node.childForFieldName("property") || node.childForFieldName("name");
			if (property) return property.text;
		}

		// Attribute access (Python): obj.method
		if (node.type === "attribute") {
			const attr = node.childForFieldName("attribute");
			if (attr) return attr.text;
		}

		return undefined;
	}

	/**
	 * Extract imported names from import statement
	 */
	private extractImportNames(node: Node): string[] {
		const names: string[] = [];

		// Walk children looking for identifiers in import clauses
		this.walkNode(node, (child) => {
			if (
				child.type === "identifier" ||
				child.type === "import_specifier" ||
				child.type === "aliased_import"
			) {
				const name = child.childForFieldName("name")?.text || child.text;
				if (name && name.length > 1) names.push(name);
			}
			return true;
		});

		return names;
	}

	/**
	 * Extract name from node
	 */
	private extractNameFromNode(node: Node): string | undefined {
		const nameNode =
			node.childForFieldName("name") || node.childForFieldName("declarator");
		if (nameNode) {
			if (
				nameNode.type === "identifier" ||
				nameNode.type === "type_identifier"
			) {
				return nameNode.text;
			}
			// Nested declarator
			const inner =
				nameNode.childForFieldName("name") ||
				nameNode.childForFieldName("declarator");
			if (inner?.type === "identifier") return inner.text;
		}
		return undefined;
	}

	/**
	 * Walk AST node recursively
	 */
	private walkNode(node: Node, callback: (node: Node) => boolean): void {
		const shouldContinue = callback(node);
		if (shouldContinue) {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child) this.walkNode(child, callback);
			}
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an AST metadata extractor instance
 */
export function createASTMetadataExtractor(): ASTMetadataExtractor {
	return new ASTMetadataExtractor();
}
