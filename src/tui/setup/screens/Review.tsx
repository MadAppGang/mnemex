/**
 * Review — summary and confirm screen.
 *
 * Shows all selections. Offers run-index-after-save prompt.
 * Enter triggers save, Esc goes back.
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";
import { GLOBAL_CONFIG_PATH } from "../../../config.js";

// ============================================================================
// Sub-components
// ============================================================================

function ShortcutItem({ letter, label }: { letter: string; label: string }) {
	return (
		<box flexDirection="row">
			<text fg={theme.shortcutBracket}>{"["}</text>
			<text fg={theme.shortcutKey}>{letter}</text>
			<text fg={theme.shortcutBracket}>{"]"}</text>
			<text fg={theme.muted}>{` ${label}  `}</text>
		</box>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<box flexDirection="row">
			<text fg={theme.labelDim}>{`  ${label.padEnd(20)}`}</text>
			<text fg={theme.valueBright}>{value}</text>
		</box>
	);
}

// ============================================================================
// Props (extends ScreenProps with save callback)
// ============================================================================

export interface ReviewScreenProps extends ScreenProps {
	onSave: () => Promise<void>;
	saveError: string | null;
	isSaving: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function ReviewScreen({
	wizardState,
	onUpdate,
	onBack,
	onQuit,
	onSave,
	saveError,
	isSaving,
}: ReviewScreenProps) {
	const [runIndex, setRunIndex] = useState<boolean | null>(
		wizardState.runIndexAfterSave,
	);

	useKeyboard((key) => {
		if (isSaving) return;

		if (key.name === "y" && runIndex === null) {
			setRunIndex(true);
			onUpdate({ runIndexAfterSave: true });
			return;
		}
		if (key.name === "n" && runIndex === null) {
			setRunIndex(false);
			onUpdate({ runIndexAfterSave: false });
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			if (runIndex === null) {
				// Ask first
				return;
			}
			void onSave();
			return;
		}
		if (key.name === "s") {
			// Save without index
			onUpdate({ runIndexAfterSave: false });
			setRunIndex(false);
			void onSave();
			return;
		}
		if (key.name === "escape") {
			onBack();
			return;
		}
		if (key.name === "q") {
			onQuit();
			return;
		}
	});

	const ws = wizardState;

	// Compute files to be written
	const filesToWrite: string[] = [];
	if (ws.scope === "global" || ws.scope === "both") {
		filesToWrite.push(GLOBAL_CONFIG_PATH);
	}
	if (ws.scope === "project" || ws.scope === "both") {
		filesToWrite.push(".mnemex/config.json");
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Review & Confirm "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Summary */}
			<box flexDirection="column" paddingLeft={2} paddingTop={2}>
				<box>
					<text fg={theme.labelDim}>{"  Configuration Summary"}</text>
				</box>

				<box marginTop={1} flexDirection="column">
					<Row label="Mode" value={ws.mode ?? "(none)"} />
					{ws.provider && (
						<Row label="Embedding provider" value={ws.provider} />
					)}
					{ws.model && <Row label="Embedding model" value={ws.model} />}
					{ws.provider === "ollama" && (
						<Row label="Ollama endpoint" value={ws.ollamaEndpoint} />
					)}
					{ws.provider === "lmstudio" && (
						<Row label="LM Studio endpoint" value={ws.lmstudioEndpoint} />
					)}
					{ws.provider === "local" && ws.localEndpoint && (
						<Row label="Custom endpoint" value={ws.localEndpoint} />
					)}
					{!ws.enrichmentSkipped && ws.llm && (
						<Row label="LLM enrichment" value={ws.llm} />
					)}
					{ws.enrichmentSkipped && (
						<Row label="LLM enrichment" value="disabled" />
					)}
					<Row label="Config scope" value={ws.scope} />
					{(ws.mode === "shared" || ws.mode === "full-cloud") &&
						ws.cloudEndpoint && (
							<Row label="Cloud endpoint" value={ws.cloudEndpoint} />
						)}
					{ws.orgSlug && <Row label="Org slug" value={ws.orgSlug} />}
					{ws.repoSlug && <Row label="Repo slug" value={ws.repoSlug} />}
				</box>

				{/* Files to write */}
				<box marginTop={2}>
					<text fg={theme.labelDim}>{"  Files to write:"}</text>
				</box>
				{filesToWrite.map((f, i) => (
					<box key={i} flexDirection="row">
						<text fg={theme.accentCyan}>{"    • "}</text>
						<text fg={theme.muted}>{f}</text>
					</box>
				))}
			</box>

			{/* Run index prompt */}
			{!isSaving && runIndex === null && (
				<box
					flexDirection="column"
					marginTop={2}
					marginLeft={2}
					borderStyle="single"
					borderColor={theme.primary}
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
				>
					<box>
						<text fg={theme.text}>
							{"Run `mnemex index .` after saving? [y/n]"}
						</text>
					</box>
				</box>
			)}

			{runIndex !== null && (
				<box paddingLeft={3} paddingTop={1} flexDirection="row">
					<text fg={theme.labelDim}>{"  Run index after save:  "}</text>
					<text fg={runIndex ? theme.accentGreen : theme.muted}>
						{runIndex ? "yes" : "no"}
					</text>
				</box>
			)}

			{/* Saving state */}
			{isSaving && (
				<box paddingLeft={3} paddingTop={1}>
					<text fg={theme.muted}>{"  Saving configuration..."}</text>
				</box>
			)}

			{/* Error banner */}
			{saveError && (
				<box
					flexDirection="column"
					marginTop={1}
					marginLeft={2}
					borderStyle="single"
					borderColor={theme.dangerBorder}
					paddingLeft={2}
					paddingRight={2}
					paddingTop={1}
					paddingBottom={1}
				>
					<box flexDirection="row">
						<text fg={theme.error}>{"! Save failed: "}</text>
						<text fg={theme.dangerText}>{saveError}</text>
					</box>
				</box>
			)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				{runIndex !== null && !isSaving && (
					<ShortcutItem letter="Enter" label="save" />
				)}
				{!isSaving && <ShortcutItem letter="s" label="save now" />}
				{!isSaving && <ShortcutItem letter="Esc" label="back" />}
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
