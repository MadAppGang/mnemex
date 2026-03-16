/**
 * DoctorView
 *
 * Context file diagnostics dashboard.
 *
 * Layout:
 *   Row 1: overall health summary
 *   Row 2: file list with scores
 *   Row 3: criteria breakdown for selected file
 */

import { useKeyboard } from "@opentui/react";
import { useAppContext } from "../context.js";
import { useDoctor } from "../hooks/useDoctor.js";
import { ScoreBar } from "../components/ScoreBar.js";
import { theme, getScoreColor } from "../theme.js";
import type { CriterionResult } from "../../core/doctor/types.js";

// ============================================================================
// Criterion Row Component
// ============================================================================

interface CriterionRowProps {
	criterion: CriterionResult;
}

function CriterionRow({ criterion }: CriterionRowProps) {
	const severityColor =
		criterion.severity === "good"
			? theme.success
			: criterion.severity === "warning"
				? theme.warning
				: theme.error;

	const severityLabel =
		criterion.severity === "good"
			? "PASS"
			: criterion.severity === "warning"
				? "WARN"
				: "FAIL";

	const normalizedScore = criterion.score / 100;

	return (
		<box flexDirection="column" paddingLeft={1} paddingBottom={1}>
			<box flexDirection="row" height={1}>
				<text fg={theme.muted} width={28}>
					{criterion.name}
				</text>
				<ScoreBar score={normalizedScore} width={8} showPercent={true} />
				<text fg={severityColor} width={8}>
					{"  " + severityLabel}
				</text>
				{criterion.issues.length > 0 && (
					<text fg={theme.dimmed}>{"  " + criterion.issues[0]}</text>
				)}
			</box>
		</box>
	);
}

// ============================================================================
// File Row Component
// ============================================================================

interface FileRowProps {
	filePath: string;
	type: string;
	tokenEstimate: number;
	score: number;
	isSelected: boolean;
}

function FileRow({
	filePath,
	type,
	tokenEstimate,
	score,
	isSelected,
}: FileRowProps) {
	const normalizedScore = score / 100;
	const shortPath =
		filePath.length > 35 ? "..." + filePath.slice(-32) : filePath;

	return (
		<box flexDirection="row" paddingLeft={1} height={1}>
			<text fg={isSelected ? theme.primary : theme.text} width={36}>
				{(isSelected ? "> " : "  ") + shortPath}
			</text>
			<text fg={theme.dimmed} width={14}>
				{type}
			</text>
			<text fg={theme.muted} width={10}>
				{tokenEstimate + " tok"}
			</text>
			<ScoreBar score={normalizedScore} width={8} showPercent={false} />
			<text fg={getScoreColor(normalizedScore)}>{" " + score + "/100"}</text>
		</box>
	);
}

// ============================================================================
// Main DoctorView Component
// ============================================================================

export function DoctorView() {
	const { projectPath } = useAppContext();
	const {
		diagnostics,
		loading,
		error,
		selectedFile,
		setSelectedFile,
		refresh,
	} = useDoctor(projectPath);

	const files = diagnostics?.files ?? [];
	const diagnoses = diagnostics?.diagnoses ?? [];
	const overallHealth = diagnostics?.overallHealth ?? 0;

	const selectedIdx = files.findIndex((f) => f.path === selectedFile);

	const selectedDiagnosis =
		selectedIdx >= 0 ? (diagnoses[selectedIdx] ?? null) : null;

	useKeyboard((key) => {
		if (key.name === "j" || key.name === "down") {
			const nextIdx = Math.min(selectedIdx + 1, files.length - 1);
			setSelectedFile(files[nextIdx]?.path ?? null);
			return;
		}
		if (key.name === "k" || key.name === "up") {
			const prevIdx = Math.max(selectedIdx - 1, 0);
			setSelectedFile(files[prevIdx]?.path ?? null);
			return;
		}
		if (key.name === "return") {
			// Enter selects the file (already selected by j/k)
			return;
		}
		if (key.name === "r") {
			refresh();
			return;
		}
	});

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
				<text fg={theme.primary}>{"Context File Health"}</text>
				{!loading && diagnostics && (
					<>
						<text fg={theme.muted}>{"  Files: "}</text>
						<text fg={theme.text}>{String(files.length)}</text>
						<text fg={theme.muted}>{"  Overall: "}</text>
						<ScoreBar
							score={overallHealth / 100}
							width={10}
							showPercent={true}
						/>
					</>
				)}
				{loading && <text fg={theme.info}>{"  Loading..."}</text>}
			</box>

			{/* Error */}
			{error && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.error}>{`Error: ${error}`}</text>
				</box>
			)}

			{/* No files */}
			{!loading && !error && files.length === 0 && (
				<box padding={2} flexDirection="column">
					<text fg={theme.muted}>
						{"No context files found (CLAUDE.md, AGENTS.md, .cursorrules)."}
					</text>
					<text fg={theme.dimmed}>
						{"Create a CLAUDE.md file to get started."}
					</text>
				</box>
			)}

			{/* File list */}
			{files.length > 0 && (
				<>
					{/* Column headers */}
					<box flexDirection="row" paddingLeft={1} height={1}>
						<text fg={theme.dimmed} width={36}>
							{"  File"}
						</text>
						<text fg={theme.dimmed} width={14}>
							{"Type"}
						</text>
						<text fg={theme.dimmed} width={10}>
							{"Tokens"}
						</text>
						<text fg={theme.dimmed}>{"Score"}</text>
					</box>

					{/* Files */}
					<box flexDirection="column">
						{files.map((file, i) => {
							const diag = diagnoses[i];
							return (
								<box key={file.path}>
									<FileRow
										filePath={file.relativePath}
										type={file.type}
										tokenEstimate={file.tokenEstimate}
										score={diag?.overallScore ?? 0}
										isSelected={file.path === selectedFile}
									/>
								</box>
							);
						})}
					</box>

					{/* Selected file criteria */}
					{selectedDiagnosis && (
						<box
							flexDirection="column"
							paddingTop={1}
							borderStyle="single"
							borderColor={theme.border}
						>
							<box paddingLeft={1} height={1}>
								<text fg={theme.primary}>
									{"Selected: " + selectedDiagnosis.file.relativePath}
								</text>
							</box>

							{/* Criteria header */}
							<box flexDirection="row" paddingLeft={1} height={1}>
								<text fg={theme.dimmed} width={28}>
									{"Criteria"}
								</text>
								<text fg={theme.dimmed} width={16}>
									{"Score"}
								</text>
								<text fg={theme.dimmed} width={8}>
									{"Level"}
								</text>
								<text fg={theme.dimmed}>{"Issues"}</text>
							</box>

							{/* Criteria rows */}
							{selectedDiagnosis.criteria.map((criterion: CriterionResult) => (
								<box key={criterion.name}>
									<CriterionRow criterion={criterion} />
								</box>
							))}

							{/* Top recommendation */}
							{selectedDiagnosis.criteria
								.flatMap((c: CriterionResult) => c.recommendations)
								.slice(0, 1)
								.map((rec: string, i: number) => (
									<box key={i} paddingLeft={1} paddingTop={1}>
										<text fg={theme.warning}>{"Tip: "}</text>
										<text fg={theme.text}>{rec}</text>
									</box>
								))}
						</box>
					)}
				</>
			)}

			{/* Hint */}
			<box paddingLeft={1} paddingTop={1} height={1}>
				<text fg={theme.dimmed}>{"r refresh  j/k navigate"}</text>
			</box>
		</box>
	);
}
