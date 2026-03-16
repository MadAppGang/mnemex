/**
 * ResultDetailView Component
 *
 * Full-screen detail view for a single search result.
 * Sections: header, info grid, description, callers, callees, syntax-highlighted code.
 * Press Esc or 'q' to return to the result list.
 */

import { useState, useEffect, useMemo } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { SearchResult, SymbolDefinition } from "../../types.js";
import { theme, getScoreColor } from "../theme.js";
import { useAppContext } from "../context.js";
import { createReferenceGraphManager } from "../../core/reference-graph.js";
import { SyntaxLine, detectLang } from "./SyntaxLine.js";
import { getVectorStorePath } from "../../config.js";
import lancedb from "@lancedb/lancedb";
import { join } from "node:path";

// ============================================================================
// Props
// ============================================================================

export interface ResultDetailViewProps {
	result: SearchResult;
	allResults: SearchResult[];
	onClose: () => void;
	onNavigate?: (newIndex: number) => void;
}

// ============================================================================
// Helpers
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

const KIND_COLORS: Record<string, string> = {
	function: "#61AFEF",
	method: "#61AFEF",
	class: "#E5C07B",
	interface: "#E5C07B",
	type: "#E5C07B",
	enum: "#E5C07B",
	module: "#8B5CF6",
};

/** Word-wrap a line to fit within maxW, appending results to `out` */
function wrapLine(text: string, maxW: number, out: string[]) {
	if (text.length <= maxW) {
		out.push(text);
		return;
	}
	const words = text.split(/\s+/);
	let current = "";
	for (const word of words) {
		if (current.length + word.length + 1 > maxW && current) {
			out.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) out.push(current);
}

/**
 * Parse structured summary content into labeled sections.
 * Input format from buildContent():
 *   File: path\n\nSummary: text\n\nResponsibilities:\n- item\n\nExports: a, b
 */
function parseSummaryContent(
	raw: string,
	maxW: number,
): Array<{ label?: string; lines: string[] }> {
	const parts: Array<{ label?: string; lines: string[] }> = [];

	// Split on known section labels at start of line
	const sectionLabels = [
		"File",
		"Summary",
		"Responsibilities",
		"Exports",
		"Dependencies",
		"Patterns",
		"Parameters",
		"Returns",
		"Side effects",
		"Usage",
		"Signature",
	];
	const labelPattern = new RegExp(`^(${sectionLabels.join("|")}):\\s*`, "im");

	// Split the raw text into sections
	const chunks: Array<{ label?: string; body: string }> = [];
	let remaining = raw;

	while (remaining.length > 0) {
		const match = remaining.match(labelPattern);
		if (!match) {
			// No more labels — rest is unlabeled content
			if (remaining.trim()) {
				chunks.push({ body: remaining.trim() });
			}
			break;
		}

		// Text before the label is unlabeled preamble
		const beforeLabel = remaining.slice(0, match.index!).trim();
		if (beforeLabel) {
			chunks.push({ body: beforeLabel });
		}

		const label = match[1];
		remaining = remaining.slice(match.index! + match[0].length);

		// Find where the next label starts
		const nextMatch = remaining.match(labelPattern);
		const body = nextMatch
			? remaining.slice(0, nextMatch.index!).trim()
			: remaining.trim();
		remaining = nextMatch ? remaining.slice(nextMatch.index!) : "";

		chunks.push({ label, body });
	}

	// Convert chunks to formatted output
	// Skip File (redundant with title bar), Dependencies (verbose, low value in UI)
	const skipLabels = new Set(["File", "Dependencies"]);
	for (const chunk of chunks) {
		if (chunk.label && skipLabels.has(chunk.label)) continue;

		const wrapped: string[] = [];
		for (const rawLine of chunk.body.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			wrapLine(line, maxW, wrapped);
		}
		if (wrapped.length > 0) {
			parts.push({ label: chunk.label, lines: wrapped });
		}
	}

	// Fallback: if parsing produced nothing, just word-wrap the whole thing
	if (parts.length === 0 && raw.trim()) {
		const lines: string[] = [];
		wrapLine(raw.trim(), maxW, lines);
		parts.push({ lines });
	}

	return parts;
}

function scoreBadgeBg(score: number): string {
	if (score >= 0.7) return "#1B5E20";
	if (score >= 0.4) return "#E65100";
	return "#B71C1C";
}

/**
 * Normalize raw PageRank to 0-1 for color display.
 * Uses log scale: with ~1500 symbols, avg is ~0.0006, max ~0.017.
 * Anything >= 5x average is "high", >= 1x average is "medium".
 */
function normalizePR(pr: number, symbolCount = 1500): number {
	const avg = 1 / symbolCount;
	const ratio = pr / avg;
	// Map: 0x avg → 0, 1x avg → 0.3, 5x avg → 0.7, 20x+ → 1.0
	if (ratio <= 0) return 0;
	return Math.min(1, Math.log(1 + ratio) / Math.log(21));
}

/** Format PageRank as readable relative importance */
function formatPR(pr: number, symbolCount = 1500): string {
	const avg = 1 / symbolCount;
	const ratio = pr / avg;
	const pctStr =
		pr >= 0.01 ? `${(pr * 100).toFixed(1)}%` : `${(pr * 100).toFixed(2)}%`;
	if (ratio >= 10) return `${pctStr} (top tier)`;
	if (ratio >= 3) return `${pctStr} (high)`;
	if (ratio >= 1) return `${pctStr} (average)`;
	return `${pctStr} (low)`;
}

/** PR badge color using relative-to-average thresholds */
function prBadgeBg(pr: number, symbolCount = 1500): string {
	const avg = 1 / symbolCount;
	const ratio = pr / avg;
	if (ratio >= 5) return "#1B5E20"; // green — well above average
	if (ratio >= 1) return "#E65100"; // orange — around average
	return "#B71C1C"; // red — below average
}

/** Strip "(part N/M)" suffix from chunk name for symbol lookup */
function baseSymbolName(name: string | undefined): string | undefined {
	if (!name) return undefined;
	return name.replace(/\s*\(part\s+\d+\/\d+\)$/i, "").trim() || undefined;
}

/** Parse "part N/M" info from chunk name */
function parsePartInfo(
	name?: string,
): { partIndex: number; totalParts: number } | null {
	if (!name) return null;
	const match = name.match(/\(part\s+(\d+)\/(\d+)\)$/i);
	if (!match) return null;
	return { partIndex: parseInt(match[1]), totalParts: parseInt(match[2]) };
}

// ============================================================================
// Section Header
// ============================================================================

function SectionHeader({
	title,
	count,
	bg,
	hint,
}: { title: string; count?: number; bg: string; hint?: string }) {
	const countStr = count !== undefined ? `  ${count}` : "";
	return (
		<box height={1} width="100%" backgroundColor={bg} flexDirection="row">
			<box>
				<text fg="#FFFFFF">{`  ${title}${countStr}  `}</text>
			</box>
			{hint && (
				<box>
					<text fg={theme.dimmed}>{hint}</text>
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Symbol Row
// ============================================================================

function SymbolRow({
	sym,
	index,
	symbolCount,
	selected,
}: {
	sym: SymbolDefinition;
	index: number;
	symbolCount: number;
	selected?: boolean;
}) {
	const kindColor = KIND_COLORS[sym.kind] ?? theme.muted;
	const kindBadge = CHUNK_TYPE_ABBREV[sym.kind] ?? sym.kind.slice(0, 4);
	const pr = sym.pagerankScore;
	const avg = 1 / symbolCount;
	const ratio = pr / avg;
	const prLabel = ratio >= 5 ? `${ratio.toFixed(0)}x` : `${ratio.toFixed(1)}x`;
	const fileName = sym.filePath.split("/").pop() ?? sym.filePath;
	const loc = `${fileName}:${sym.startLine}`;
	const prefix = selected
		? "  \u25B6   "
		: `  ${String(index + 1).padStart(2)}.  `;

	return (
		<box
			height={1}
			flexDirection="row"
			backgroundColor={selected ? "#37474F" : undefined}
		>
			<box>
				<text fg={selected ? theme.info : theme.dimmed}>{prefix}</text>
			</box>
			<box backgroundColor={kindColor}>
				<text fg="#000000">{` ${kindBadge.padEnd(4)} `}</text>
			</box>
			<box>
				<text fg={theme.dimmed}> </text>
			</box>
			<box>
				<text fg={theme.text}>
					{sym.name.length > 28 ? `${sym.name.slice(0, 26)}\u2026` : sym.name}
				</text>
			</box>
			<box>
				<text fg={theme.dimmed}>{"  "}</text>
			</box>
			<box>
				<text fg={theme.muted}>{loc}</text>
			</box>
			<box>
				<text fg={theme.dimmed}>{"  "}</text>
			</box>
			<box backgroundColor={prBadgeBg(pr, symbolCount)}>
				<text fg="#FFFFFF">{` PR:${prLabel} `}</text>
			</box>
			{sym.isExported && (
				<box>
					<text fg={theme.success}>{" exported"}</text>
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Info Row
// ============================================================================

function InfoRow({
	label,
	value,
	valueFg,
}: { label: string; value: string; valueFg?: string }) {
	return (
		<box height={1} flexDirection="row">
			<box>
				<text fg={theme.muted}>{`    ${label.padEnd(12)}`}</text>
			</box>
			<box>
				<text fg={valueFg ?? theme.text}>{value}</text>
			</box>
		</box>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ResultDetailView({
	result,
	allResults,
	onClose,
}: ResultDetailViewProps) {
	const { tracker, projectPath } = useAppContext();
	const { width } = useTerminalDimensions();

	// Local override for navigating to parts not in search results
	const [overrideResult, setOverrideResult] = useState<SearchResult | null>(
		null,
	);
	const activeResult = overrideResult ?? result;
	const { chunk, score, vectorScore, keywordScore } = activeResult;

	// Reset override when the external result changes (user navigated via onNavigate)
	useEffect(() => {
		setOverrideResult(null);
	}, [result]);

	const [callers, setCallers] = useState<SymbolDefinition[]>([]);
	const [callees, setCallees] = useState<SymbolDefinition[]>([]);
	const [focusedSymbol, setFocusedSymbol] = useState<SymbolDefinition | null>(
		null,
	);
	const [graphLoaded, setGraphLoaded] = useState(false);
	const [symbolCount, setSymbolCount] = useState(1500); // updated from graph

	// Drill-down navigation state
	const [focusSection, setFocusSection] = useState<
		"callers" | "callees" | null
	>(null);
	const [sectionIdx, setSectionIdx] = useState(0);
	const [navStack, setNavStack] = useState<SearchResult[]>([]);

	// Strip "(part N/M)" for graph lookup
	const symbolName = baseSymbolName(chunk.name);

	// Part navigation — load ALL parts from the store (not just search results)
	const partInfo = parsePartInfo(chunk.name);
	const [allSiblingResults, setAllSiblingResults] = useState<SearchResult[]>(
		[],
	);

	useEffect(() => {
		if (!partInfo || !symbolName) {
			setAllSiblingResults([]);
			return;
		}
		let cancelled = false;
		async function loadSiblings() {
			try {
				const storePath = getVectorStorePath(projectPath);
				const db = await lancedb.connect(storePath);
				const tables = await db.tableNames();
				if (!tables.includes("code_chunks")) return;
				const table = await db.openTable("code_chunks");

				// Escape single quotes in name for SQL
				const escapedName = symbolName.replace(/'/g, "''");
				const escapedPath = chunk.filePath.replace(/'/g, "''");
				const rows = await table
					.query()
					.where(
						`name LIKE '${escapedName} (part %' AND \`filePath\` = '${escapedPath}'`,
					)
					.toArray();
				if (cancelled) return;

				// Sort by startLine and deduplicate by part index
				const sorted = rows.sort((a: any, b: any) => a.startLine - b.startLine);
				const seen = new Set<number>();
				const deduped = sorted.filter((row: any) => {
					const pi = parsePartInfo(row.name);
					if (!pi) return false;
					if (seen.has(pi.partIndex)) return false;
					seen.add(pi.partIndex);
					return true;
				});

				// Build SearchResult map from existing search results
				const searchMap = new Map<number, SearchResult>();
				for (const r of allResults) {
					const rBase = baseSymbolName(r.chunk.name);
					const rPi = parsePartInfo(r.chunk.name);
					if (
						rBase === symbolName &&
						rPi &&
						r.chunk.filePath === chunk.filePath
					) {
						if (!searchMap.has(rPi.partIndex)) {
							searchMap.set(rPi.partIndex, r);
						}
					}
				}

				const results: SearchResult[] = deduped.map((row: any) => {
					const pi = parsePartInfo(row.name)!.partIndex;
					const existing = searchMap.get(pi);
					if (existing) return existing;
					return {
						chunk: {
							id: row.id,
							contentHash: row.contentHash || "",
							content: row.content,
							filePath: row.filePath,
							startLine: row.startLine,
							endLine: row.endLine,
							language: row.language,
							chunkType: row.chunkType,
							name: row.name || undefined,
							parentName: row.parentName || undefined,
							signature: row.signature || undefined,
							fileHash: row.fileHash,
						},
						score: 0,
						vectorScore: 0,
						keywordScore: 0,
					};
				});

				if (!cancelled) setAllSiblingResults(results);
			} catch {
				if (!cancelled) setAllSiblingResults([]);
			}
		}
		void loadSiblings();
		return () => {
			cancelled = true;
		};
	}, [projectPath, symbolName, chunk.filePath, partInfo !== null]);

	// Current position within siblings (match by part number)
	const currentSiblingIdx = partInfo
		? allSiblingResults.findIndex((r) => {
				const pi = parsePartInfo(r.chunk.name);
				return pi !== null && pi.partIndex === partInfo.partIndex;
			})
		: -1;

	// Build reference graph
	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const gm = createReferenceGraphManager(tracker);
				await gm.buildGraph();
				if (cancelled) return;

				// Get symbol count for PageRank normalization
				const allSyms = tracker.getAllSymbols();
				if (!cancelled && allSyms.length > 0) {
					setSymbolCount(allSyms.length);
				}

				if (symbolName) {
					const sym = gm.findSymbol(symbolName, {
						preferExported: true,
						fileHint: chunk.filePath,
					});
					if (sym && !cancelled) {
						setFocusedSymbol(sym);
						setCallers(gm.getCallers(sym.id).slice(0, 15));
						setCallees(gm.getCallees(sym.id).slice(0, 15));
					}
				}
			} catch {
				// Graph unavailable
			} finally {
				if (!cancelled) setGraphLoaded(true);
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [tracker, symbolName, chunk.filePath]);

	// Navigate into a caller/callee symbol by loading its chunk from LanceDB
	async function navigateToSymbol(sym: SymbolDefinition) {
		try {
			const storePath = getVectorStorePath(projectPath);
			const db = await lancedb.connect(storePath);
			const tables = await db.tableNames();
			if (!tables.includes("code_chunks")) return;
			const table = await db.openTable("code_chunks");

			const escapedName = sym.name.replace(/'/g, "''");
			// SymbolDefinition.filePath is relative; LanceDB stores absolute
			const absPath = join(projectPath, sym.filePath).replace(/'/g, "''");

			// Try exact name match first, then partitioned name
			let rows = await table
				.query()
				.where(`name = '${escapedName}' AND \`filePath\` = '${absPath}'`)
				.limit(1)
				.toArray();
			if (rows.length === 0) {
				rows = await table
					.query()
					.where(
						`name LIKE '${escapedName} (part %' AND \`filePath\` = '${absPath}'`,
					)
					.limit(1)
					.toArray();
			}

			if (rows.length === 0) return;
			const row = rows[0] as any;

			const newResult: SearchResult = {
				chunk: {
					id: row.id,
					contentHash: row.contentHash || "",
					content: row.content,
					filePath: row.filePath,
					startLine: row.startLine,
					endLine: row.endLine,
					language: row.language,
					chunkType: row.chunkType,
					name: row.name || undefined,
					parentName: row.parentName || undefined,
					signature: row.signature || undefined,
					fileHash: row.fileHash,
				},
				score: 0,
				vectorScore: 0,
				keywordScore: 0,
				summary: row.summary || undefined,
			};

			// Push current result onto nav stack, then navigate
			setNavStack((prev) => [...prev, activeResult]);
			setOverrideResult(newResult);
			setFocusSection(null);
			setSectionIdx(0);
			// Reset graph state so it reloads for the new symbol
			setGraphLoaded(false);
			setCallers([]);
			setCallees([]);
			setFocusedSymbol(null);
		} catch {
			// LanceDB lookup failed — stay on current view
		}
	}

	// Keyboard
	useKeyboard((key) => {
		// q always closes entirely
		if (key.name === "q") {
			onClose();
			return;
		}

		// Escape: exit section focus → pop nav stack → close
		if (key.name === "escape") {
			if (focusSection) {
				setFocusSection(null);
				setSectionIdx(0);
				return;
			}
			if (navStack.length > 0) {
				const prev = navStack[navStack.length - 1];
				setNavStack((s) => s.slice(0, -1));
				setOverrideResult(prev);
				setGraphLoaded(false);
				setCallers([]);
				setCallees([]);
				setFocusedSymbol(null);
				return;
			}
			onClose();
			return;
		}

		// c/e: focus callers/callees section
		if (key.raw === "c" && callers.length > 0) {
			setFocusSection("callers");
			setSectionIdx(0);
			return;
		}
		if (key.raw === "e" && callees.length > 0) {
			setFocusSection("callees");
			setSectionIdx(0);
			return;
		}

		// j/k or up/down: move selection within focused section
		if (focusSection) {
			const list = focusSection === "callers" ? callers : callees;
			if (
				(key.name === "down" || key.raw === "j") &&
				sectionIdx < list.length - 1
			) {
				setSectionIdx((i) => i + 1);
				return;
			}
			if ((key.name === "up" || key.raw === "k") && sectionIdx > 0) {
				setSectionIdx((i) => i - 1);
				return;
			}
			if (key.name === "return" && list[sectionIdx]) {
				void navigateToSymbol(list[sectionIdx]);
				return;
			}
		}

		// Part navigation (only when no section focused)
		if (!focusSection) {
			if (key.name === "left" && currentSiblingIdx > 0) {
				setOverrideResult(allSiblingResults[currentSiblingIdx - 1]);
				return;
			}
			if (
				key.name === "right" &&
				currentSiblingIdx >= 0 &&
				currentSiblingIdx < allSiblingResults.length - 1
			) {
				setOverrideResult(allSiblingResults[currentSiblingIdx + 1]);
				return;
			}
		}
	});

	// ── Computed values ─────────────────────────────────────────────────
	const pct = Math.round(score * 100);
	const vecPct = Math.round(vectorScore * 100);
	const kwPct = Math.round(keywordScore * 100);

	const ut = (activeResult as any).unitType as string | undefined;
	const ct = chunk.chunkType;
	const typeLabel = ut && ut !== "unknown" ? ut : ct || "code";
	const badge = CHUNK_TYPE_ABBREV[typeLabel] ?? typeLabel.substring(0, 4);
	const kindColor = KIND_COLORS[typeLabel] ?? theme.muted;

	const name = chunk.name
		? chunk.parentName
			? `${chunk.parentName}.${chunk.name}`
			: chunk.name
		: "unnamed";

	const lineCount = chunk.endLine - chunk.startLine;
	const lang = detectLang(chunk.filePath);

	// Signature
	const sig = chunk.signature?.replace(/\s+/g, " ").trim();

	// PageRank — display relative to average (Nx avg)
	const prStr = focusedSymbol
		? formatPR(focusedSymbol.pagerankScore, symbolCount)
		: graphLoaded
			? "n/a"
			: "...";

	// Inherit part 1's summary when this part has none
	const effectiveSummary = useMemo(() => {
		if (activeResult.summary) return activeResult.summary;
		if (!partInfo || !allSiblingResults.length) return undefined;
		// Find any sibling's summary (typically part 1)
		for (const s of allSiblingResults) {
			if (s.summary) return s.summary;
		}
		return undefined;
	}, [activeResult.summary, partInfo, allSiblingResults]);

	// Parsed summary lines — symbol summary (specific) and file summary (overview)
	const hasSummary = !!(effectiveSummary || activeResult.fileSummary);
	const hasSymbolSummary =
		!!effectiveSummary && effectiveSummary !== activeResult.fileSummary;
	const hasFileSummary = !!activeResult.fileSummary;

	function parseSummaryToLines(
		raw: string,
	): Array<{ text: string; fg: string; indent: number }> {
		const maxW = Math.max(40, (width || 80) - 8);
		const parts = parseSummaryContent(raw, maxW);
		const lines: Array<{ text: string; fg: string; indent: number }> = [];
		for (const part of parts) {
			if (part.label) {
				lines.push({ text: part.label + ":", fg: theme.info, indent: 4 });
			}
			for (const line of part.lines) {
				lines.push({
					text: line,
					fg: line.startsWith("- ") ? theme.muted : theme.text,
					indent: part.label ? 6 : 4,
				});
			}
		}
		return lines;
	}

	const symbolSummaryLines = useMemo(
		() => (hasSymbolSummary ? parseSummaryToLines(effectiveSummary!) : []),
		[effectiveSummary, width],
	);
	const fileSummaryLines = useMemo(
		() =>
			hasFileSummary ? parseSummaryToLines(activeResult.fileSummary!) : [],
		[activeResult.fileSummary, width],
	);

	// Dead code detection: 0 callers + graph loaded + named symbol
	const isDeadCode =
		graphLoaded && symbolName && callers.length === 0 && focusedSymbol !== null;

	// Code lines for manual syntax-highlighted rendering
	const codeLines = useMemo(() => {
		return chunk.content.split("\n");
	}, [chunk.content]);

	const gutterWidth = String(chunk.startLine + codeLines.length).length;

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* ── Title bar ────────────────────────────────────────────────── */}
			<box
				height={1}
				width="100%"
				backgroundColor="#1E3A5F"
				flexDirection="row"
			>
				<box>
					<text
						fg={theme.text}
					>{`  ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}  `}</text>
				</box>
				<box backgroundColor={kindColor}>
					<text fg="#000000">{` ${badge} `}</text>
				</box>
				<box>
					<text fg={theme.dimmed}> </text>
				</box>
				<box>
					<text fg={theme.text}>{name}</text>
				</box>
				<box>
					<text fg={theme.dimmed}>{"  "}</text>
				</box>
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
					<text fg={theme.dimmed}>
						{navStack.length > 0
							? `    Esc back (${navStack.length} deep)`
							: "    Esc back"}
					</text>
				</box>
			</box>

			{/* ── Part navigation bar ─────────────────────────────────────── */}
			{partInfo &&
				allSiblingResults.length > 1 &&
				(() => {
					const hasLeft = currentSiblingIdx > 0;
					const hasRight =
						currentSiblingIdx >= 0 &&
						currentSiblingIdx < allSiblingResults.length - 1;
					return (
						<box
							height={1}
							width="100%"
							backgroundColor="#37474F"
							flexDirection="row"
						>
							<box>
								<text
									fg={hasLeft ? theme.info : theme.dimmed}
								>{`  ${hasLeft ? "\u25C0" : " "} `}</text>
							</box>
							<box>
								<text
									fg={theme.text}
								>{`Part ${partInfo.partIndex}/${partInfo.totalParts}`}</text>
							</box>
							<box>
								<text
									fg={hasRight ? theme.info : theme.dimmed}
								>{` ${hasRight ? "\u25B6" : " "}  `}</text>
							</box>
							<box>
								<text fg={theme.muted}>{symbolName ?? ""}</text>
							</box>
							<box>
								<text fg={theme.dimmed}>
									{"    \u2190/\u2192 navigate parts"}
								</text>
							</box>
						</box>
					);
				})()}

			{/* ── Breadcrumb bar ───────────────────────────────────────────── */}
			{navStack.length > 0 &&
				(() => {
					const crumbs = navStack.map((r) => {
						const n = baseSymbolName(r.chunk.name) ?? "?";
						const f = r.chunk.filePath.split("/").pop() ?? "";
						return `${n} (${f})`;
					});
					const currentCrumb = baseSymbolName(chunk.name) ?? "?";
					const sep = " › ";
					const prefix = "◀ ";
					const maxW = (width || 80) - 4;

					// Truncate from the left if too long
					let parts = [...crumbs, currentCrumb];
					let full = prefix + parts.join(sep);
					while (full.length > maxW && parts.length > 2) {
						parts = ["…", ...parts.slice(2)];
						full = prefix + parts.join(sep);
					}

					return (
						<box
							height={1}
							width="100%"
							backgroundColor="#263238"
							flexDirection="row"
						>
							<box>
								<text fg={theme.info}>{`  ${prefix}`}</text>
							</box>
							{parts.map((p, i) => {
								const isLast = i === parts.length - 1;
								const isSep = i < parts.length - 1;
								return (
									<box key={`bc-${i}`} flexDirection="row">
										<box>
											<text fg={isLast ? theme.text : theme.muted}>{p}</text>
										</box>
										{isSep && (
											<box>
												<text fg={theme.dimmed}>{sep}</text>
											</box>
										)}
									</box>
								);
							})}
						</box>
					);
				})()}

			{/* ── Scrollable body ──────────────────────────────────────────── */}
			<scrollbox width="100%" height="100%">
				{/* ── Info section ──────────────────────────────────────── */}
				<SectionHeader title="INFO" bg="#263238" />
				<InfoRow label="type" value={typeLabel} valueFg={kindColor} />
				<InfoRow
					label="language"
					value={chunk.language || "unknown"}
					valueFg={theme.info}
				/>
				<InfoRow
					label="lines"
					value={`${chunk.startLine}-${chunk.endLine} (${lineCount} lines)`}
				/>
				<InfoRow
					label="pagerank"
					value={prStr}
					valueFg={getScoreColor(
						normalizePR(focusedSymbol?.pagerankScore ?? 0, symbolCount),
					)}
				/>
				{focusedSymbol?.isExported && (
					<InfoRow label="exported" value="yes" valueFg={theme.success} />
				)}
				{isDeadCode && (
					<InfoRow
						label="status"
						value="POTENTIALLY DEAD (0 callers)"
						valueFg="#EF5350"
					/>
				)}
				{sig && (
					<box height={1} flexDirection="row">
						<box>
							<text fg={theme.muted}>{"    sig         "}</text>
						</box>
						<box>
							<text fg={theme.warning}>
								{sig.length > width - 20
									? `${sig.slice(0, width - 23)}\u2026`
									: sig}
							</text>
						</box>
					</box>
				)}

				{/* ── Dead code warning ────────────────────────────────── */}
				{isDeadCode && (
					<box
						height={1}
						width="100%"
						backgroundColor="#B71C1C"
						flexDirection="row"
					>
						<box>
							<text fg="#FFFFFF">{`  POTENTIALLY DEAD CODE  `}</text>
						</box>
						<box>
							<text fg="#FFCDD2">{`0 callers found — this symbol may be unused`}</text>
						</box>
					</box>
				)}

				{/* ── Symbol Summary (function/class specific) ─────────── */}
				{hasSymbolSummary && (
					<>
						<box height={1}>
							<text fg={theme.dimmed}>{""}</text>
						</box>
						<SectionHeader title="SYMBOL SUMMARY" bg="#37474F" />
						{symbolSummaryLines.map((sl, i) => (
							<box
								key={`ss-${i}`}
								height={1}
								paddingLeft={sl.indent}
								flexDirection="row"
							>
								<text fg={sl.fg}>{sl.text}</text>
							</box>
						))}
					</>
				)}

				{/* ── File Summary (file-level overview) ───────────────── */}
				{hasFileSummary && (
					<>
						<box height={1}>
							<text fg={theme.dimmed}>{""}</text>
						</box>
						<SectionHeader title="FILE SUMMARY" bg="#455A64" />
						{fileSummaryLines.map((sl, i) => (
							<box
								key={`fs-${i}`}
								height={1}
								paddingLeft={sl.indent}
								flexDirection="row"
							>
								<text fg={sl.fg}>{sl.text}</text>
							</box>
						))}
					</>
				)}

				{/* ── No summary fallback ──────────────────────────────── */}
				{!hasSummary && (
					<>
						<box height={1}>
							<text fg={theme.dimmed}>{""}</text>
						</box>
						<SectionHeader title="SUMMARY" bg="#37474F" />
						<box height={1} flexDirection="row" paddingLeft={4}>
							<text fg={theme.dimmed}>
								{"no summary (run mnemex index to generate)"}
							</text>
						</box>
					</>
				)}

				{/* ── Callers ───────────────────────────────────────────── */}
				<box height={1}>
					<text fg={theme.dimmed}>{""}</text>
				</box>
				<SectionHeader
					title={graphLoaded ? "CALLERS (who depends on this)" : "CALLERS"}
					count={graphLoaded ? callers.length : undefined}
					bg="#1A237E"
					hint={
						callers.length > 0
							? focusSection === "callers"
								? "j/k ↑↓  Enter open  Esc back"
								: "c to select"
							: undefined
					}
				/>
				{!graphLoaded && (
					<box height={1} flexDirection="row">
						<box>
							<text fg={theme.dimmed}>{"    loading graph..."}</text>
						</box>
					</box>
				)}
				{graphLoaded && callers.length === 0 && (
					<box height={1} flexDirection="row">
						<box>
							<text fg={theme.dimmed}>{"    no callers found"}</text>
						</box>
					</box>
				)}
				{callers.map((sym, i) => (
					<SymbolRow
						key={`caller-${i}`}
						sym={sym}
						index={i}
						symbolCount={symbolCount}
						selected={focusSection === "callers" && sectionIdx === i}
					/>
				))}

				{/* ── Callees ───────────────────────────────────────────── */}
				<box height={1}>
					<text fg={theme.dimmed}>{""}</text>
				</box>
				<SectionHeader
					title={graphLoaded ? "CALLEES (what this depends on)" : "CALLEES"}
					count={graphLoaded ? callees.length : undefined}
					bg="#4A148C"
					hint={
						callees.length > 0
							? focusSection === "callees"
								? "j/k ↑↓  Enter open  Esc back"
								: "e to select"
							: undefined
					}
				/>
				{!graphLoaded && (
					<box height={1} flexDirection="row">
						<box>
							<text fg={theme.dimmed}>{"    loading graph..."}</text>
						</box>
					</box>
				)}
				{graphLoaded && callees.length === 0 && (
					<box height={1} flexDirection="row">
						<box>
							<text fg={theme.dimmed}>{"    no callees found"}</text>
						</box>
					</box>
				)}
				{callees.map((sym, i) => (
					<SymbolRow
						key={`callee-${i}`}
						sym={sym}
						index={i}
						symbolCount={symbolCount}
						selected={focusSection === "callees" && sectionIdx === i}
					/>
				))}

				{/* ── Code (syntax highlighted) ────────────────────────── */}
				<box height={1}>
					<text fg={theme.dimmed}>{""}</text>
				</box>
				<SectionHeader title={`CODE  ${chunk.filePath}`} bg="#263238" />
				{codeLines.map((line, i) => {
					const lineNo = chunk.startLine + i;
					const num = String(lineNo).padStart(gutterWidth);
					return (
						<box key={`code-${lineNo}`} height={1} flexDirection="row">
							<box>
								<text fg={theme.dimmed}>{` ${num} \u2502 `}</text>
							</box>
							<box>
								<SyntaxLine line={line} lang={lang} />
							</box>
						</box>
					);
				})}
			</scrollbox>
		</box>
	);
}
