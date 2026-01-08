/**
 * Validate Tree-sitter Queries
 *
 * Tests all language queries against their grammars to catch syntax errors.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, Query } from "web-tree-sitter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const grammarsPath = join(__dirname, "../grammars");

// Language configurations (same as parser-manager.ts)
const LANGUAGE_CONFIGS: Record<
	string,
	{ grammarFile: string; chunkQuery: string; referenceQuery?: string }
> = {
	typescript: {
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
	python: {
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
	rust: {
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
};

async function validateQueries() {
	console.log("🔍 Validating tree-sitter queries...\n");

	await Parser.init({
		locateFile: (scriptName: string) => join(grammarsPath, scriptName),
	});

	let hasErrors = false;
	const results: {
		lang: string;
		query: string;
		status: "ok" | "error";
		error?: string;
	}[] = [];

	for (const [langName, config] of Object.entries(LANGUAGE_CONFIGS)) {
		const grammarPath = join(grammarsPath, config.grammarFile);

		if (!existsSync(grammarPath)) {
			console.log(
				`⚠️  ${langName}: Grammar file not found (${config.grammarFile})`,
			);
			continue;
		}

		try {
			const wasmBuffer = readFileSync(grammarPath);
			const lang = await Language.load(wasmBuffer);

			// Test chunkQuery
			try {
				new Query(lang, config.chunkQuery);
				results.push({ lang: langName, query: "chunkQuery", status: "ok" });
			} catch (error) {
				hasErrors = true;
				const msg = error instanceof Error ? error.message : String(error);
				results.push({
					lang: langName,
					query: "chunkQuery",
					status: "error",
					error: msg,
				});
			}

			// Test referenceQuery if present
			if (config.referenceQuery) {
				try {
					new Query(lang, config.referenceQuery);
					results.push({
						lang: langName,
						query: "referenceQuery",
						status: "ok",
					});
				} catch (error) {
					hasErrors = true;
					const msg = error instanceof Error ? error.message : String(error);
					results.push({
						lang: langName,
						query: "referenceQuery",
						status: "error",
						error: msg,
					});
				}
			}
		} catch (error) {
			console.log(`❌ ${langName}: Failed to load grammar - ${error}`);
			hasErrors = true;
		}
	}

	// Print results
	console.log("Results:");
	console.log("─".repeat(60));

	for (const r of results) {
		if (r.status === "ok") {
			console.log(`✅ ${r.lang.padEnd(12)} ${r.query.padEnd(16)} OK`);
		} else {
			console.log(`❌ ${r.lang.padEnd(12)} ${r.query.padEnd(16)} ERROR`);
			console.log(`   ${r.error}`);
		}
	}

	console.log("─".repeat(60));

	if (hasErrors) {
		console.log("\n❌ Some queries have errors!");
		process.exit(1);
	} else {
		console.log("\n✅ All queries are valid!");
		process.exit(0);
	}
}

validateQueries().catch(console.error);
