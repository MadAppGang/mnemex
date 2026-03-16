/**
 * CodePreview Component
 *
 * Wraps the OpenTUI <code> component with auto-detected filetype from extension.
 * Shows line numbers and truncates long content.
 */

import { extname } from "node:path";
import { SyntaxStyle } from "@opentui/core";
import { theme } from "../theme.js";

// ============================================================================
// Language Detection
// ============================================================================

const EXT_TO_FILETYPE: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".hpp": "cpp",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".md": "markdown",
	".sql": "sql",
	".html": "html",
	".css": "css",
	".scss": "scss",
	".ruby": "ruby",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".kt": "kotlin",
};

function detectFiletype(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	return EXT_TO_FILETYPE[ext] ?? "text";
}

// ============================================================================
// Shared syntax style (created once)
// ============================================================================

const defaultSyntaxStyle = SyntaxStyle.create();

// ============================================================================
// Props
// ============================================================================

export interface CodePreviewProps {
	/** Source code content */
	content: string;
	/** File path (used to detect language) */
	filePath: string;
	/** Starting line number for display purposes */
	startLine?: number;
	/** Maximum lines to display before truncating */
	maxLines?: number;
}

// ============================================================================
// Component
// ============================================================================

export function CodePreview({
	content,
	filePath,
	startLine = 1,
	maxLines = 40,
}: CodePreviewProps) {
	const filetype = detectFiletype(filePath);
	const lines = content.split("\n");
	const truncated = lines.length > maxLines;
	const displayLines = truncated ? lines.slice(0, maxLines) : lines;
	const displayContent = displayLines.join("\n");
	const remaining = lines.length - maxLines;

	return (
		<box flexDirection="column" width="100%">
			<box paddingLeft={1} paddingBottom={0}>
				<text fg={theme.muted}>{filePath}</text>
				{startLine > 1 && <text fg={theme.dimmed}> (line {startLine})</text>}
			</box>
			<code
				content={displayContent}
				filetype={filetype}
				syntaxStyle={defaultSyntaxStyle}
			/>
			{truncated && (
				<text fg={theme.muted} paddingLeft={1}>
					... {remaining} more lines
				</text>
			)}
		</box>
	);
}
