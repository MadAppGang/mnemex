/**
 * Structural Query Builder
 *
 * Builds tree-sitter s-expression queries from query intent + entity name.
 * Currently supports TypeScript/JavaScript. Other languages return null.
 */

import type { QueryIntent, SupportedLanguage } from "../../../types.js";

/**
 * Build a tree-sitter query string for the given intent, entity, and language.
 * Returns null if the combination is not supported.
 */
export function buildStructuralQuery(
	intent: QueryIntent,
	entityName: string,
	language: SupportedLanguage,
): string | null {
	if (
		language !== "typescript" &&
		language !== "javascript" &&
		language !== "tsx" &&
		language !== "jsx"
	) {
		return null;
	}

	// Escape entity name for use in #eq? predicates
	const safeName = entityName.replace(/"/g, '\\"');

	switch (intent) {
		case "structural":
			// Caller query: find call expressions referencing entityName
			return `(call_expression
  function: [
    (identifier) @name
    (member_expression
      property: (property_identifier) @name)
  ]
  (#eq? @name "${safeName}")) @call`;

		case "symbol_lookup": {
			// Look for class, function, interface, or type declarations
			const classDecl = `(class_declaration
  name: (type_identifier) @name
  (#eq? @name "${safeName}")) @decl`;

			const fnDecl = `(function_declaration
  name: (identifier) @name
  (#eq? @name "${safeName}")) @decl`;

			const interfaceDecl = `(interface_declaration
  name: (type_identifier) @name
  (#eq? @name "${safeName}")) @decl`;

			const typeDecl = `(type_alias_declaration
  name: (type_identifier) @name
  (#eq? @name "${safeName}")) @decl`;

			const methodDecl = `(method_definition
  name: (property_identifier) @name
  (#eq? @name "${safeName}")) @decl`;

			return [classDecl, fnDecl, interfaceDecl, typeDecl, methodDecl].join(
				"\n",
			);
		}

		default:
			return null;
	}
}

/**
 * Detect language from file extension.
 */
export function detectLanguageFromPath(
	filePath: string,
): SupportedLanguage | null {
	const ext = filePath.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
		case "mts":
		case "cts":
			return "typescript";
		case "tsx":
			return "tsx";
		case "js":
		case "mjs":
		case "cjs":
			return "javascript";
		case "jsx":
			return "jsx";
		case "py":
		case "pyw":
		case "pyi":
			return "python";
		case "go":
			return "go";
		case "rs":
			return "rust";
		default:
			return null;
	}
}
