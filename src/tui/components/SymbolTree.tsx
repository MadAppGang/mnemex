/**
 * SymbolTree Component
 *
 * Collapsible file/symbol tree for the Map view.
 * Shows files as collapsible nodes with symbols indented underneath.
 */

import type { RepoMapEntry } from "../../types.js";
import { ScoreBar } from "./ScoreBar.js";
import { theme } from "../theme.js";

// ============================================================================
// Props
// ============================================================================

export interface SymbolTreeProps {
	entries: RepoMapEntry[];
	expandedPaths: Set<string>;
	onToggle: (path: string) => void;
	selectedPath: string | null;
	onSelect: (path: string) => void;
}

// ============================================================================
// Helper: Format PageRank for display
// ============================================================================

function formatPageRank(score: number): string {
	return score.toFixed(3);
}

// ============================================================================
// Symbol Row Component
// ============================================================================

interface SymbolRowProps {
	name: string;
	kind: string;
	pagerankScore: number;
	line: number;
	isExported?: boolean;
}

function SymbolRow({
	name,
	kind,
	pagerankScore,
	line,
	isExported,
}: SymbolRowProps) {
	const prefix = isExported ? "+ " : ". ";
	// Normalize score for bar: treat 0.1 as 100%
	const normalizedScore = Math.min(1, pagerankScore / 0.1);

	return (
		<box flexDirection="row" paddingLeft={4} height={1}>
			<text fg={isExported ? theme.success : theme.muted}>{prefix}</text>
			<text fg={theme.text} width={28}>
				{name}
			</text>
			<text fg={theme.dimmed} width={12}>
				{kind}
			</text>
			<text fg={theme.muted} width={8}>
				{":" + line}
			</text>
			<ScoreBar score={normalizedScore} width={8} showPercent={false} />
			<text fg={theme.dimmed}> {formatPageRank(pagerankScore)}</text>
		</box>
	);
}

// ============================================================================
// File Row Component
// ============================================================================

interface FileRowProps {
	filePath: string;
	symbolCount: number;
	aggregatePageRank: number;
	isExpanded: boolean;
	isSelected: boolean;
}

function FileRow({
	filePath,
	symbolCount,
	aggregatePageRank,
	isExpanded,
	isSelected,
}: FileRowProps) {
	const icon = isExpanded ? "v " : "> ";
	const normalizedAgg = Math.min(1, aggregatePageRank / 0.3);

	return (
		<box flexDirection="row" paddingLeft={2} height={1}>
			<text fg={isSelected ? theme.primary : theme.warning}>{icon}</text>
			<text fg={isSelected ? theme.text : theme.primary} width={40}>
				{filePath}
			</text>
			<text fg={theme.muted} width={12}>
				{symbolCount + " sym"}
			</text>
			<ScoreBar score={normalizedAgg} width={8} showPercent={false} />
			<text fg={theme.dimmed}>
				{" agg:" + formatPageRank(aggregatePageRank)}
			</text>
		</box>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function SymbolTree({
	entries,
	expandedPaths,
	onToggle,
	selectedPath,
	onSelect,
}: SymbolTreeProps) {
	if (entries.length === 0) {
		return (
			<box padding={2}>
				<text fg={theme.muted}>No symbols indexed. Run: mnemex index</text>
			</box>
		);
	}

	return (
		<scrollbox width="100%" height="100%">
			{entries.map((entry) => {
				const isExpanded = expandedPaths.has(entry.filePath);
				const isSelected = selectedPath === entry.filePath;
				const aggregatePageRank = entry.symbols.reduce(
					(sum, s) => sum + s.pagerankScore,
					0,
				);

				return (
					<box key={entry.filePath} flexDirection="column" width="100%">
						<FileRow
							filePath={entry.filePath}
							symbolCount={entry.symbols.length}
							aggregatePageRank={aggregatePageRank}
							isExpanded={isExpanded}
							isSelected={isSelected}
						/>

						{isExpanded &&
							entry.symbols.map((sym) => (
								<box key={entry.filePath + ":" + sym.name + ":" + sym.line}>
									<SymbolRow
										name={sym.name}
										kind={sym.kind}
										pagerankScore={sym.pagerankScore}
										line={sym.line}
										isExported={
											sym.kind !== "variable" && !sym.name.startsWith("_")
										}
									/>
								</box>
							))}
					</box>
				);
			})}
		</scrollbox>
	);
}
