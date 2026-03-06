/**
 * Dependency Graph
 *
 * Manages document type dependencies and determines extraction order.
 * Uses topological sort to ensure dependencies are processed first.
 */

import type { DocumentType } from "../../types.js";

// ============================================================================
// Default Dependencies
// ============================================================================

/**
 * Default dependency relationships between document types.
 * Each key depends on its array of values being completed first.
 */
const DEFAULT_DEPENDENCIES: Record<DocumentType, DocumentType[]> = {
	// Code chunks are the foundation - no dependencies
	code_chunk: [],

	// File summary depends on having code chunks
	file_summary: ["code_chunk"],

	// Symbol summary depends on code chunks
	symbol_summary: ["code_chunk"],

	// Idioms depend on code chunks and file summaries
	idiom: ["code_chunk", "file_summary"],

	// Usage examples depend on code chunks and symbol summaries
	usage_example: ["code_chunk", "symbol_summary"],

	// Anti-patterns depend on code chunks
	anti_pattern: ["code_chunk"],

	// Project docs are the highest level - depend on summaries and idioms
	project_doc: ["file_summary", "idiom"],

	// External documentation types - no internal dependencies
	// These come from external sources (Context7, llms.txt, DevDocs)
	framework_doc: [],
	best_practice: [],
	api_reference: [],

	// Session observations - no dependencies (written directly)
	session_observation: [],
};

// ============================================================================
// Dependency Graph Class
// ============================================================================

export class DependencyGraph {
	private dependencies: Map<DocumentType, Set<DocumentType>>;
	private reverseDeps: Map<DocumentType, Set<DocumentType>>;

	constructor(customDeps?: Partial<Record<DocumentType, DocumentType[]>>) {
		this.dependencies = new Map();
		this.reverseDeps = new Map();

		// Initialize with default dependencies
		for (const [type, deps] of Object.entries(DEFAULT_DEPENDENCIES)) {
			this.registerDependency(type as DocumentType, deps as DocumentType[]);
		}

		// Apply custom overrides
		if (customDeps) {
			for (const [type, deps] of Object.entries(customDeps)) {
				if (deps) {
					this.registerDependency(type as DocumentType, deps);
				}
			}
		}
	}

	/**
	 * Register dependencies for a document type
	 */
	registerDependency(type: DocumentType, dependsOn: DocumentType[]): void {
		this.dependencies.set(type, new Set(dependsOn));

		// Build reverse dependency map
		for (const dep of dependsOn) {
			if (!this.reverseDeps.has(dep)) {
				this.reverseDeps.set(dep, new Set());
			}
			this.reverseDeps.get(dep)!.add(type);
		}
	}

	/**
	 * Get dependencies for a document type
	 */
	getDependencies(type: DocumentType): DocumentType[] {
		return Array.from(this.dependencies.get(type) || []);
	}

	/**
	 * Get types that depend on the given type
	 */
	getDependents(type: DocumentType): DocumentType[] {
		return Array.from(this.reverseDeps.get(type) || []);
	}

	/**
	 * Get extraction order using topological sort.
	 * Returns types in the order they should be processed.
	 */
	getExtractionOrder(types: DocumentType[]): DocumentType[] {
		const typesSet = new Set(types);
		const result: DocumentType[] = [];
		const visited = new Set<DocumentType>();
		const visiting = new Set<DocumentType>();

		const visit = (type: DocumentType): void => {
			if (visited.has(type)) return;
			if (visiting.has(type)) {
				throw new Error(`Circular dependency detected involving ${type}`);
			}

			visiting.add(type);

			// Visit dependencies first
			const deps = this.dependencies.get(type) || new Set();
			for (const dep of deps) {
				if (typesSet.has(dep)) {
					visit(dep);
				}
			}

			visiting.delete(type);
			visited.add(type);
			result.push(type);
		};

		for (const type of types) {
			visit(type);
		}

		return result;
	}

	/**
	 * Get all types affected when a given type changes.
	 * Returns the type itself plus all types that depend on it (transitively).
	 */
	getAffectedTypes(changedType: DocumentType): DocumentType[] {
		const affected = new Set<DocumentType>([changedType]);
		const queue = [changedType];

		while (queue.length > 0) {
			const current = queue.shift()!;
			const dependents = this.reverseDeps.get(current) || new Set();

			for (const dep of dependents) {
				if (!affected.has(dep)) {
					affected.add(dep);
					queue.push(dep);
				}
			}
		}

		return Array.from(affected);
	}

	/**
	 * Check if all dependencies for a type are satisfied.
	 */
	areDependenciesSatisfied(
		type: DocumentType,
		completedTypes: Set<DocumentType>,
	): boolean {
		const deps = this.dependencies.get(type) || new Set();
		for (const dep of deps) {
			if (!completedTypes.has(dep)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Get types that can be extracted now given completed types.
	 */
	getReadyTypes(
		targetTypes: DocumentType[],
		completedTypes: Set<DocumentType>,
	): DocumentType[] {
		return targetTypes.filter(
			(type) =>
				!completedTypes.has(type) &&
				this.areDependenciesSatisfied(type, completedTypes),
		);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a dependency graph with optional custom dependencies
 */
export function createDependencyGraph(
	customDeps?: Partial<Record<DocumentType, DocumentType[]>>,
): DependencyGraph {
	return new DependencyGraph(customDeps);
}
