/**
 * Code Unit Extractor
 *
 * Extracts hierarchical code units from source files with parent-child relationships.
 * Builds on tree-sitter AST parsing and integrates with the metadata extractor.
 *
 * Key features:
 * - Hierarchical extraction (file → class → method)
 * - Parent-child relationships via parentId
 * - Depth tracking for bottom-up processing
 * - Rich AST metadata extraction
 */

import { createHash } from "node:crypto";
import type { Node, Tree } from "web-tree-sitter";
import {
	getParserManager,
	type ParserManager,
} from "../../parsers/parser-manager.js";
import type {
	ASTMetadata,
	CodeUnit,
	SupportedLanguage,
	UnitType,
} from "../../types.js";
import {
	ASTMetadataExtractor,
	type ExtractionContext,
} from "./metadata-extractor.js";

// ============================================================================
// Types
// ============================================================================

export interface ExtractionOptions {
	/** Include file-level unit (default: true) */
	includeFile?: boolean;
	/** Maximum depth to extract (default: unlimited) */
	maxDepth?: number;
	/** Minimum content length to include (default: 10) */
	minContentLength?: number;
}

interface ExtractedUnit {
	node: Node;
	unitType: UnitType;
	name?: string;
	parentId: string | null;
	depth: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Map AST node types to unit types */
const NODE_TYPE_TO_UNIT_TYPE: Record<string, UnitType> = {
	// Functions
	function_declaration: "function",
	function_definition: "function", // Python - may be reclassified as method if inside class
	function_item: "function",
	arrow_function: "function",
	function_expression: "function",
	// Classes
	class_declaration: "class",
	class_definition: "class",
	class_specifier: "class",
	// Interfaces
	interface_declaration: "interface",
	// Methods
	method_definition: "method",
	method_declaration: "method", // Go receiver methods
	// Types
	type_alias_declaration: "type",
	// Note: type_declaration handled specially for Go (can contain struct/interface)
	// Enums
	enum_declaration: "enum",
	enum_item: "enum",
	enum_specifier: "enum",
	// Structs (treated as classes for consistency)
	struct_item: "class",
	struct_specifier: "class",
	// Go-specific: type_spec is handled specially based on child type
	type_spec: "type", // Will be reclassified based on struct_type/interface_type child
	// Rust traits/impls
	trait_item: "interface",
	impl_item: "class",
};

/** Node types that can contain children we want to extract */
const CONTAINER_TYPES = new Set([
	"class_declaration",
	"class_definition",
	"class_body",
	"class_specifier",
	"interface_declaration",
	"interface_body",
	"struct_item",
	"struct_specifier",
	"trait_item",
	"impl_item",
	"enum_declaration",
	"enum_body",
	"module",
	"program",
	"source_file",
	"block",
	"statement_block",
	// Go-specific containers
	"type_declaration", // Contains type_spec children
]);

// ============================================================================
// Code Unit Extractor Class
// ============================================================================

export class CodeUnitExtractor {
	private parserManager: ParserManager;
	private metadataExtractor: ASTMetadataExtractor;

	constructor() {
		this.parserManager = getParserManager();
		this.metadataExtractor = new ASTMetadataExtractor();
	}

	/**
	 * Extract all code units from a source file
	 */
	async extractUnits(
		source: string,
		filePath: string,
		language: SupportedLanguage,
		fileHash: string,
		options: ExtractionOptions = {},
	): Promise<CodeUnit[]> {
		const { includeFile = true, maxDepth, minContentLength = 10 } = options;

		// Parse the source
		const tree = await this.parserManager.parse(source, language);
		if (!tree) {
			// Return file-level unit only if parsing fails
			if (includeFile) {
				return [this.createFileUnit(source, filePath, language, fileHash)];
			}
			return [];
		}

		const units: CodeUnit[] = [];
		const ctx: ExtractionContext = { filePath, source, language };

		// Add file-level unit
		let fileUnitId: string | null = null;
		if (includeFile) {
			const fileUnit = this.createFileUnit(
				source,
				filePath,
				language,
				fileHash,
			);
			units.push(fileUnit);
			fileUnitId = fileUnit.id;
		}

		// Extract hierarchical units from AST (now passing filePath and language for consistent ID generation)
		const extractedUnits = this.walkAndExtract(
			tree.rootNode,
			fileUnitId,
			1,
			maxDepth,
			source,
			filePath,
			language,
		);

		// Convert to CodeUnit format
		for (const extracted of extractedUnits) {
			const content = source.slice(
				extracted.node.startIndex,
				extracted.node.endIndex,
			);

			// Skip tiny units
			if (content.trim().length < minContentLength) {
				continue;
			}

			const name = extracted.name || this.extractName(extracted.node, language);
			const signature = this.extractSignature(extracted.node, source);
			const metadata = this.metadataExtractor.extractMetadata(
				extracted.node,
				ctx,
			);

			const unit = this.createCodeUnit({
				node: extracted.node,
				unitType: extracted.unitType,
				name,
				signature,
				content,
				filePath,
				language,
				fileHash,
				parentId: extracted.parentId,
				depth: extracted.depth,
				metadata,
			});

			units.push(unit);
		}

		return units;
	}

	/**
	 * Walk AST and extract units with hierarchy
	 * Fixed: Now passes filePath and language through recursion for consistent ID generation
	 * Enhanced: Context-aware type detection for Python methods and Go structs/interfaces
	 */
	private walkAndExtract(
		node: Node,
		parentId: string | null,
		currentDepth: number,
		maxDepth: number | undefined,
		source: string,
		filePath: string,
		language: SupportedLanguage,
	): ExtractedUnit[] {
		const results: ExtractedUnit[] = [];

		// Check depth limit
		if (maxDepth !== undefined && currentDepth > maxDepth) {
			return results;
		}

		// Check if this node is a unit we want to extract
		let unitType = NODE_TYPE_TO_UNIT_TYPE[node.type];

		// Context-aware type detection
		if (unitType) {
			unitType = this.refineUnitType(node, unitType, language);
		}

		if (unitType) {
			// This is a code unit - extract it and use it as parent for children
			const name = this.extractName(node, language);
			// Generate ID using same logic as createCodeUnit to ensure parent-child consistency
			const unitId = this.generateConsistentUnitId(
				filePath,
				unitType,
				name,
				node.startPosition.row,
			);

			results.push({
				node,
				unitType,
				name,
				parentId,
				depth: currentDepth,
			});

			// Continue extracting children with this unit as parent
			const childResults = this.extractChildren(
				node,
				unitId,
				currentDepth + 1,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		} else if (CONTAINER_TYPES.has(node.type)) {
			// This is a container - extract children with current parent
			const childResults = this.extractChildren(
				node,
				parentId,
				currentDepth,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		} else {
			// Regular node - check children
			const childResults = this.extractChildren(
				node,
				parentId,
				currentDepth,
				maxDepth,
				source,
				filePath,
				language,
			);
			results.push(...childResults);
		}

		return results;
	}

	/**
	 * Refine unit type based on context
	 * - Python function_definition inside class → method
	 * - Go type_spec with struct_type → class
	 * - Go type_spec with interface_type → interface
	 */
	private refineUnitType(
		node: Node,
		baseType: UnitType,
		language: SupportedLanguage,
	): UnitType {
		// Python: function inside class is a method
		if (language === "python" && node.type === "function_definition") {
			if (this.isInsideClass(node)) {
				return "method";
			}
		}

		// Go: type_spec - check child type
		if (language === "go" && node.type === "type_spec") {
			// Look for struct_type or interface_type child
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "struct_type") {
					return "class";
				}
				if (child?.type === "interface_type") {
					return "interface";
				}
			}
			// Fall back to "type" for type aliases
			return "type";
		}

		return baseType;
	}

	/**
	 * Check if a node is inside a class definition
	 */
	private isInsideClass(node: Node): boolean {
		let current = node.parent;
		while (current) {
			if (
				current.type === "class_definition" ||
				current.type === "class_declaration"
			) {
				return true;
			}
			current = current.parent;
		}
		return false;
	}

	/**
	 * Extract children of a node
	 */
	private extractChildren(
		node: Node,
		parentId: string | null,
		currentDepth: number,
		maxDepth: number | undefined,
		source: string,
		filePath: string,
		language: SupportedLanguage,
	): ExtractedUnit[] {
		const results: ExtractedUnit[] = [];

		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child) {
				const childResults = this.walkAndExtract(
					child,
					parentId,
					currentDepth,
					maxDepth,
					source,
					filePath,
					language,
				);
				results.push(...childResults);
			}
		}

		return results;
	}

	/**
	 * Generate consistent unit ID matching createCodeUnit logic
	 * This ensures parentId values match actual unit IDs
	 */
	private generateConsistentUnitId(
		filePath: string,
		unitType: string,
		name: string | undefined,
		startRow: number,
	): string {
		const idSource = `${filePath}:${unitType}:${name || "anon"}:${startRow}`;
		return createHash("sha256").update(idSource).digest("hex").slice(0, 16);
	}

	/**
	 * Create a file-level code unit
	 */
	private createFileUnit(
		source: string,
		filePath: string,
		language: SupportedLanguage,
		fileHash: string,
	): CodeUnit {
		const lines = source.split("\n");
		const id = createHash("sha256")
			.update(`file:${filePath}:${fileHash}`)
			.digest("hex")
			.slice(0, 16);

		return {
			id,
			parentId: null,
			unitType: "file",
			filePath,
			startLine: 1,
			endLine: lines.length,
			language,
			content: source,
			name: filePath.split("/").pop(),
			fileHash,
			depth: 0,
		};
	}

	/**
	 * Create a code unit from extracted data
	 */
	private createCodeUnit(data: {
		node: Node;
		unitType: UnitType;
		name?: string;
		signature?: string;
		content: string;
		filePath: string;
		language: SupportedLanguage;
		fileHash: string;
		parentId: string | null;
		depth: number;
		metadata?: ASTMetadata;
	}): CodeUnit {
		const {
			node,
			unitType,
			name,
			signature,
			content,
			filePath,
			language,
			fileHash,
			parentId,
			depth,
			metadata,
		} = data;

		// Create stable ID from file path, name, type, and position
		const idSource = `${filePath}:${unitType}:${name || "anon"}:${node.startPosition.row}`;
		const id = createHash("sha256").update(idSource).digest("hex").slice(0, 16);

		return {
			id,
			parentId,
			unitType,
			filePath,
			startLine: node.startPosition.row + 1, // 1-indexed
			endLine: node.endPosition.row + 1,
			language,
			content,
			name,
			signature,
			fileHash,
			depth,
			metadata,
		};
	}

	/**
	 * Extract name from AST node
	 */
	private extractName(
		node: Node,
		language: SupportedLanguage,
	): string | undefined {
		// Go-specific: type_spec has type_identifier as direct child
		if (node.type === "type_spec") {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "type_identifier") {
					return child.text;
				}
			}
		}

		// Go-specific: method_declaration has field_identifier for method name
		if (node.type === "method_declaration") {
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child?.type === "field_identifier") {
					return child.text;
				}
			}
		}

		// Try common name field patterns
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

		// For arrow functions assigned to variables
		if (node.type === "arrow_function") {
			const parent = node.parent;
			if (parent?.type === "variable_declarator") {
				const varName = parent.childForFieldName("name");
				if (varName?.type === "identifier") {
					return varName.text;
				}
			}
		}

		// For impl blocks in Rust
		if (node.type === "impl_item") {
			const typeNode = node.childForFieldName("type");
			if (typeNode?.type === "type_identifier") {
				return `impl ${typeNode.text}`;
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

		// Limit length
		if (sig.length > 300) {
			sig = sig.slice(0, 297) + "...";
		}

		return sig || undefined;
	}

	/**
	 * Get units sorted by depth (deepest first) for bottom-up processing
	 */
	sortByDepthDesc(units: CodeUnit[]): CodeUnit[] {
		return [...units].sort((a, b) => b.depth - a.depth);
	}

	/**
	 * Get units sorted by depth (shallowest first) for top-down processing
	 */
	sortByDepthAsc(units: CodeUnit[]): CodeUnit[] {
		return [...units].sort((a, b) => a.depth - b.depth);
	}

	/**
	 * Get children of a unit
	 */
	getChildren(units: CodeUnit[], parentId: string): CodeUnit[] {
		return units.filter((u) => u.parentId === parentId);
	}

	/**
	 * Get parent of a unit
	 */
	getParent(units: CodeUnit[], childId: string): CodeUnit | undefined {
		const child = units.find((u) => u.id === childId);
		if (!child || !child.parentId) return undefined;
		return units.find((u) => u.id === child.parentId);
	}

	/**
	 * Build a map of units by ID for fast lookup
	 */
	buildUnitMap(units: CodeUnit[]): Map<string, CodeUnit> {
		return new Map(units.map((u) => [u.id, u]));
	}

	/**
	 * Get units at a specific depth level
	 */
	getUnitsAtDepth(units: CodeUnit[], depth: number): CodeUnit[] {
		return units.filter((u) => u.depth === depth);
	}

	/**
	 * Get the maximum depth in the unit hierarchy
	 */
	getMaxDepth(units: CodeUnit[]): number {
		return Math.max(...units.map((u) => u.depth), 0);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a code unit extractor instance
 */
export function createCodeUnitExtractor(): CodeUnitExtractor {
	return new CodeUnitExtractor();
}
