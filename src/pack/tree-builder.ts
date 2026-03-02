/**
 * Tree Builder
 *
 * Builds an ASCII directory tree from a list of file entries.
 * Directories are sorted before files. Binary files get a [binary] suffix.
 */

import type { FileEntry } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Internal tree node */
interface TreeNode {
	name: string;
	isDirectory: boolean;
	isBinary: boolean;
	children: Map<string, TreeNode>;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Build a tree node structure from a list of file entries.
 */
function buildTreeNodes(entries: FileEntry[]): Map<string, TreeNode> {
	const root = new Map<string, TreeNode>();

	for (const entry of entries) {
		const parts = entry.relativePath.split("/");
		let current = root;

		// Create directory nodes for each path segment
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			if (!current.has(part)) {
				current.set(part, {
					name: part,
					isDirectory: true,
					isBinary: false,
					children: new Map(),
				});
			}
			const node = current.get(part)!;
			current = node.children;
		}

		// Create the file node
		const fileName = parts[parts.length - 1];
		current.set(fileName, {
			name: fileName,
			isDirectory: false,
			isBinary: entry.isBinary,
			children: new Map(),
		});
	}

	return root;
}

/**
 * Render a tree node and its children to lines.
 * Directories come before files (sorted alphabetically within each group).
 */
function renderNode(
	nodes: Map<string, TreeNode>,
	prefix: string,
	lines: string[],
): void {
	// Sort: directories first, then files, each group alphabetically
	const sorted = Array.from(nodes.values()).sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	for (let i = 0; i < sorted.length; i++) {
		const node = sorted[i];
		const isLast = i === sorted.length - 1;
		const connector = isLast ? "└── " : "├── ";
		const childPrefix = isLast ? "    " : "│   ";

		let label = node.name;
		if (node.isDirectory) {
			label += "/";
		} else if (node.isBinary) {
			label += " [binary]";
		}

		lines.push(`${prefix}${connector}${label}`);

		if (node.isDirectory && node.children.size > 0) {
			renderNode(node.children, prefix + childPrefix, lines);
		}
	}
}

/**
 * Build an ASCII directory tree from a list of file entries.
 *
 * Output format:
 * ```
 * ├── src/
 * │   ├── cli.ts
 * │   └── types.ts
 * └── package.json
 * ```
 *
 * @param entries - List of file entries to include in the tree
 * @returns Multi-line string representing the directory tree
 */
export function buildTree(entries: FileEntry[]): string {
	const nodes = buildTreeNodes(entries);
	const lines: string[] = [];
	renderNode(nodes, "", lines);
	return lines.join("\n");
}
