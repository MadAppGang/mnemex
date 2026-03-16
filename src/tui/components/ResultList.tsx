/**
 * ResultList Component
 *
 * GitHub code search-style result display:
 *   - File header: path:range + type name + score %
 *   - Manual syntax coloring + keyword term highlighting
 *   - Context-windowed line selection
 *   - Selected result: yellow background header
 *   - Manual scroll windowing for j/k navigation
 */

import { useMemo } from "react";
import { useTerminalDimensions } from "@opentui/react";
import type { SearchResult, ASTMetadata } from "../../types.js";
import { CodePreview } from "./CodePreview.js";
import { theme, getScoreColor } from "../theme.js";
import { SyntaxLine, detectLang } from "./SyntaxLine.js";

// ============================================================================
// Constants
// ============================================================================

const CHUNK_TYPE_ABBREV: Record<string, string> = {
	function: "fn",
	method: "method",
	class: "cls",
	interface: "iface",
	type: "type",
	enum: "enum",
	module: "mod",
	block: "block",
	"document-section": "doc",
	chunk: "code",
	file: "file",
};

// ============================================================================
// Helpers
// ============================================================================

function typeBadge(result: SearchResult): string {
	const ut = result.unitType;
	const ct = result.chunk.chunkType;
	const label = ut && ut !== "unknown" ? ut : ct || "code";
	return CHUNK_TYPE_ABBREV[label] ?? label.substring(0, 4);
}

function displayName(result: SearchResult): string {
	const { chunk } = result;
	if (chunk.name) {
		return chunk.parentName ? `${chunk.parentName}.${chunk.name}` : chunk.name;
	}
	const lines = chunk.content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (
			trimmed &&
			trimmed.length > 2 &&
			!trimmed.startsWith("//") &&
			!trimmed.startsWith("/*")
		) {
			const match = trimmed.match(
				/(?:function|class|const|let|var|export|type|interface)\s+(\w+)/,
			);
			if (match) return match[1];
			return trimmed.length > 40 ? `${trimmed.substring(0, 37)}...` : trimmed;
		}
	}
	return "unnamed";
}

function buildAstBadge(metadata?: ASTMetadata): {
	text: string;
	hasAST: boolean;
} {
	if (!metadata || Object.keys(metadata).length === 0) {
		return { text: "", hasAST: false };
	}
	const parts: string[] = [];
	if (metadata.isExported) parts.push("exported");
	if (metadata.isAsync) parts.push("async");
	if (metadata.isGenerator) parts.push("gen");
	if (metadata.isStatic) parts.push("static");
	if (metadata.visibility && metadata.visibility !== "exported")
		parts.push(metadata.visibility);
	if (metadata.parameters) parts.push(`${metadata.parameters.length} params`);
	if (metadata.returnType) parts.push(`-> ${metadata.returnType}`);
	return { text: parts.length > 0 ? parts.join(", ") : "AST", hasAST: true };
}

// ============================================================================
// Description extraction
// ============================================================================

/** Get a one-line description: LLM summary > signature > "no summary". */
function getChunkDescription(
	signature: string | undefined,
	termWidth: number,
	summary?: string,
): string {
	let desc = "";
	if (summary) {
		desc = summary.replace(/\s+/g, " ").trim();
	} else if (signature) {
		desc = signature.replace(/\s+/g, " ").trim();
	} else {
		return "no summary";
	}
	const maxLen = Math.max(termWidth - 4, 20);
	return desc.length > maxLen ? `${desc.slice(0, maxLen - 1)}\u2026` : desc;
}

// ============================================================================
// Context-Windowed Line Selection
// ============================================================================

interface DisplayLine {
	lineNo: number;
	text: string;
	isGap: boolean;
}

function getMatchLines(
	content: string,
	startLine: number,
	terms: string[],
	contextRadius = 2,
	maxLines = 15,
): DisplayLine[] {
	const lines = content.split("\n");

	const matchIndices = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].toLowerCase();
		for (const term of terms) {
			if (lower.includes(term.toLowerCase())) {
				matchIndices.add(i);
				break;
			}
		}
	}

	if (matchIndices.size === 0) {
		const count = Math.min(lines.length, 10);
		const result: DisplayLine[] = [];
		for (let i = 0; i < count; i++) {
			result.push({ lineNo: startLine + i, text: lines[i], isGap: false });
		}
		if (lines.length > count) {
			result.push({ lineNo: 0, text: "", isGap: true });
		}
		return result;
	}

	const included = new Set<number>();
	for (const idx of matchIndices) {
		for (
			let c = Math.max(0, idx - contextRadius);
			c <= Math.min(lines.length - 1, idx + contextRadius);
			c++
		) {
			included.add(c);
		}
	}

	const sorted = [...included].sort((a, b) => a - b);
	const result: DisplayLine[] = [];
	let prev = -2;
	for (const idx of sorted) {
		if (result.length >= maxLines) break;
		if (prev >= 0 && idx > prev + 1) {
			result.push({ lineNo: 0, text: "", isGap: true });
		}
		result.push({ lineNo: startLine + idx, text: lines[idx], isGap: false });
		prev = idx;
	}
	return result;
}

// ============================================================================
// Card height estimation for scroll windowing
// ============================================================================

function estimateCardHeight(
	content: string,
	startLine: number,
	terms: string[],
): number {
	const displayLines = getMatchLines(content, startLine, terms);
	// header(1) + description(1) + code lines + blank(1)
	return 1 + 1 + displayLines.length + 1;
}

// ============================================================================
// Props
// ============================================================================

export interface ResultListProps {
	results: SearchResult[];
	query: string;
	selectedIndex: number;
	expandedIndex: number | null;
	onSelect: (idx: number) => void;
	onToggleExpand: (idx: number) => void;
}

// ============================================================================
// Result Row Component
// ============================================================================

interface ResultRowProps {
	result: SearchResult;
	isSelected: boolean;
	isExpanded: boolean;
	terms: string[];
}

const SELECTED_BG = "#B8860B";
const SELECTED_FG = "#000000";

/** Background color for a score value (darker = worse) */
function scoreBadgeBg(score: number): string {
	if (score >= 0.7) return "#1B5E20"; // dark green
	if (score >= 0.4) return "#E65100"; // dark orange
	return "#B71C1C"; // dark red
}

function ResultRow({ result, isSelected, isExpanded, terms }: ResultRowProps) {
	const { chunk, score, vectorScore, keywordScore } = result;
	const { width } = useTerminalDimensions();
	const badge = typeBadge(result);
	const name = displayName(result);
	const pct = Math.round(score * 100);
	const vecPct = Math.round(vectorScore * 100);
	const kwPct = Math.round(keywordScore * 100);
	const pointer = isSelected ? "\u25b8" : " ";
	const lang = detectLang(chunk.filePath);
	const lineCount = chunk.endLine - chunk.startLine;

	const pathRange = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
	const nameLabel = `${badge} ${name}`;

	const displayLines = useMemo(
		() => getMatchLines(chunk.content, chunk.startLine, terms),
		[chunk.content, chunk.startLine, terms],
	);
	const maxLineNo = displayLines.reduce(
		(m, l) => (l.isGap ? m : Math.max(m, l.lineNo)),
		0,
	);
	const gutterWidth = Math.max(String(maxLineNo).length, 3);

	const headerBg = isSelected ? SELECTED_BG : undefined;
	const headerFg = isSelected ? SELECTED_FG : theme.text;
	const headerDimFg = isSelected ? SELECTED_FG : theme.dimmed;

	const description = useMemo(
		() => getChunkDescription(chunk.signature, width, result.summary),
		[chunk.signature, width, result.summary],
	);

	return (
		<box flexDirection="column" width="100%">
			{/* Header: pointer + path + name + score badges */}
			<box
				height={1}
				width="100%"
				backgroundColor={headerBg}
				flexDirection="row"
			>
				<box>
					<text fg={headerDimFg}>{`${pointer} `}</text>
				</box>
				<box>
					<text fg={headerFg}>{pathRange}</text>
				</box>
				<box>
					<text fg={headerDimFg}>{`  ${nameLabel}  `}</text>
				</box>
				{/* Score badges with colored backgrounds */}
				<box backgroundColor={scoreBadgeBg(score)}>
					<text fg="#FFFFFF">{` ${pct}% `}</text>
				</box>
				<box>
					<text fg={theme.dimmed}> </text>
				</box>
				<box backgroundColor="#1A237E">
					<text fg="#90CAF9">{` v:${vecPct}% `}</text>
				</box>
				<box>
					<text fg={theme.dimmed}> </text>
				</box>
				<box backgroundColor="#4A148C">
					<text fg="#CE93D8">{` k:${kwPct}% `}</text>
				</box>
				<box>
					<text fg={theme.dimmed}> </text>
				</box>
				<box>
					<text fg={theme.info}>{chunk.language || lang}</text>
				</box>
				{lineCount > 0 && (
					<box>
						<text fg={theme.dimmed}>{` ${lineCount}L`}</text>
					</box>
				)}
			</box>

			{/* One-line description: signature or first code line */}
			<box height={1} flexDirection="row">
				<box>
					<text fg={theme.dimmed}>{`   ${description}`}</text>
				</box>
			</box>

			{/* Code lines: gutter + syntax-colored + term-highlighted */}
			{displayLines.map((dl, i) => {
				if (dl.isGap) {
					return (
						<box key={`gap-${i}`} height={1} flexDirection="row">
							<text
								fg={theme.dimmed}
							>{`${" ".repeat(gutterWidth + 2)}\u2502   ...`}</text>
						</box>
					);
				}
				const lineNum = String(dl.lineNo).padStart(gutterWidth);
				return (
					<box key={`l-${dl.lineNo}`} height={1} flexDirection="row">
						<box>
							<text fg={theme.dimmed}>{` ${lineNum} \u2502 `}</text>
						</box>
						<box>
							<SyntaxLine line={dl.text} terms={terms} lang={lang} />
						</box>
					</box>
				);
			})}

			{/* Visual separator: blank line between results */}
			{!isExpanded && (
				<box height={1} width="100%">
					<text fg={theme.dimmed}>{""}</text>
				</box>
			)}

			{/* Expanded view */}
			{isExpanded && <ExpandedDetails result={result} />}
		</box>
	);
}

// ============================================================================
// Expanded Details
// ============================================================================

function ExpandedDetails({ result }: { result: SearchResult }) {
	const { chunk } = result;
	const metadata = (result as any).metadata as ASTMetadata | undefined;
	const summary = (result as any).summary as string | undefined;
	const { hasAST } = buildAstBadge(metadata);

	return (
		<box
			flexDirection="column"
			paddingLeft={3}
			paddingBottom={1}
			paddingTop={1}
		>
			{summary && (
				<box height={1} flexDirection="row">
					<box>
						<text fg={theme.muted}>{"desc  "}</text>
					</box>
					<box>
						<text fg={theme.text}>{summary}</text>
					</box>
				</box>
			)}
			{chunk.signature && (
				<box height={1} flexDirection="row">
					<box>
						<text fg={theme.muted}>{"sig   "}</text>
					</box>
					<box>
						<text fg={theme.warning}>
							{chunk.signature.replace(/\s+/g, " ").trim()}
						</text>
					</box>
				</box>
			)}
			<CodePreview
				content={chunk.content}
				filePath={chunk.filePath}
				startLine={chunk.startLine}
				maxLines={15}
			/>
			{hasAST && metadata && (
				<box flexDirection="column" paddingTop={1}>
					<text fg={theme.muted}>{"AST Metadata:"}</text>
					{metadata.parameters && metadata.parameters.length > 0 && (
						<box paddingLeft={2} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"params   "}</text>
							</box>
							<box>
								<text fg={theme.text}>
									{metadata.parameters
										.map((p: any) => (p.type ? `${p.name}: ${p.type}` : p.name))
										.join(", ")}
								</text>
							</box>
						</box>
					)}
					{metadata.returnType && (
						<box paddingLeft={2} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"returns  "}</text>
							</box>
							<box>
								<text fg={theme.text}>{metadata.returnType}</text>
							</box>
						</box>
					)}
					{metadata.functionsCalled && metadata.functionsCalled.length > 0 && (
						<box paddingLeft={2} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"calls    "}</text>
							</box>
							<box>
								<text fg={theme.info}>
									{metadata.functionsCalled.join(", ")}
								</text>
							</box>
						</box>
					)}
					{metadata.typesReferenced && metadata.typesReferenced.length > 0 && (
						<box paddingLeft={2} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"types    "}</text>
							</box>
							<box>
								<text fg={theme.info}>
									{metadata.typesReferenced.join(", ")}
								</text>
							</box>
						</box>
					)}
					{metadata.importsUsed && metadata.importsUsed.length > 0 && (
						<box paddingLeft={2} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"imports  "}</text>
							</box>
							<box>
								<text fg={theme.text}>{metadata.importsUsed.join(", ")}</text>
							</box>
						</box>
					)}
					{metadata.docstring && (
						<box paddingLeft={2} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{"doc      "}</text>
							</box>
							<box>
								<text fg={theme.text}>{metadata.docstring}</text>
							</box>
						</box>
					)}
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Main Component — manual scroll windowing
// ============================================================================

export function ResultList({
	results,
	query,
	selectedIndex,
	expandedIndex,
	onSelect,
	onToggleExpand,
}: ResultListProps) {
	const { height } = useTerminalDimensions();

	if (results.length === 0) {
		return (
			<box padding={2}>
				<text fg={theme.muted}>No results</text>
			</box>
		);
	}

	const terms = query.split(/\s+/).filter((t) => t.length > 0);

	// Card heights for scroll windowing
	const cardHeights = results.map((r) =>
		estimateCardHeight(r.chunk.content, r.chunk.startLine, terms),
	);

	const availHeight = Math.max(height - 5, 10);

	// Scroll offset so selected card is visible
	let scrollOffset = 0;
	let cumH = 0;
	for (let i = 0; i <= selectedIndex; i++) cumH += cardHeights[i];
	if (cumH > availHeight) {
		let h = cardHeights[selectedIndex];
		scrollOffset = selectedIndex;
		for (let i = selectedIndex - 1; i >= 0; i--) {
			if (h + cardHeights[i] > availHeight) break;
			h += cardHeights[i];
			scrollOffset = i;
		}
	}

	// Visible card count
	let visibleCount = 0;
	let usedH = 0;
	for (let i = scrollOffset; i < results.length; i++) {
		if (usedH + cardHeights[i] > availHeight) break;
		usedH += cardHeights[i];
		visibleCount++;
	}
	const visibleResults = results.slice(
		scrollOffset,
		scrollOffset + Math.max(1, visibleCount),
	);

	return (
		<box flexDirection="column" width="100%" height="100%">
			{scrollOffset > 0 && (
				<box height={1}>
					<text fg={theme.dimmed}>{`  \u25b2 ${scrollOffset} more above`}</text>
				</box>
			)}

			{visibleResults.map((result, vi) => {
				const actualIndex = scrollOffset + vi;
				return (
					<box key={result.chunk.id}>
						<ResultRow
							result={result}
							isSelected={actualIndex === selectedIndex}
							isExpanded={actualIndex === expandedIndex}
							terms={terms}
						/>
					</box>
				);
			})}

			{scrollOffset + visibleCount < results.length && (
				<box height={1}>
					<text
						fg={theme.dimmed}
					>{`  \u25bc ${results.length - scrollOffset - visibleCount} more below`}</text>
				</box>
			)}
		</box>
	);
}
