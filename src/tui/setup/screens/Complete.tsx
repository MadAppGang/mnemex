/**
 * Complete — done screen shown after successful config save.
 *
 * Shows config file location and next steps.
 * Enter or q to exit.
 */

import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";
import { GLOBAL_CONFIG_PATH } from "../../../config.js";

// ============================================================================
// Component
// ============================================================================

export function CompleteScreen({ wizardState, onQuit }: ScreenProps) {
	useKeyboard((key) => {
		if (
			key.name === "return" ||
			key.name === "enter" ||
			key.name === "q" ||
			key.name === "escape"
		) {
			onQuit();
		}
	});

	const filesToWrite: string[] = [];
	if (wizardState.scope === "global" || wizardState.scope === "both") {
		filesToWrite.push(GLOBAL_CONFIG_PATH);
	}
	if (wizardState.scope === "project" || wizardState.scope === "both") {
		filesToWrite.push(".mnemex/config.json");
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.accentGreen}>{" Setup Complete "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Success message */}
			<box flexDirection="column" paddingLeft={3} paddingTop={3}>
				<box flexDirection="row">
					<text fg={theme.accentGreen}>
						{"  Configuration saved successfully!"}
					</text>
				</box>

				<box marginTop={2}>
					<text fg={theme.labelDim}>{"  Files written:"}</text>
				</box>
				{filesToWrite.map((f, i) => (
					<box key={i} flexDirection="row">
						<text fg={theme.accentGreen}>{"    ✓ "}</text>
						<text fg={theme.muted}>{f}</text>
					</box>
				))}

				<box marginTop={3}>
					<text fg={theme.labelDim}>{"  Next steps:"}</text>
				</box>
				<box paddingLeft={4} flexDirection="row">
					<text fg={theme.accentCyan}>{"1. "}</text>
					<text fg={theme.text}>{"Index your project:"}</text>
				</box>
				<box paddingLeft={7}>
					<text fg={theme.valueBright}>{"mnemex index ."}</text>
				</box>
				<box marginTop={1} paddingLeft={4} flexDirection="row">
					<text fg={theme.accentCyan}>{"2. "}</text>
					<text fg={theme.text}>{"Search your codebase:"}</text>
				</box>
				<box paddingLeft={7}>
					<text fg={theme.valueBright}>{'mnemex search "your query"'}</text>
				</box>
				<box marginTop={1} paddingLeft={4} flexDirection="row">
					<text fg={theme.accentCyan}>{"3. "}</text>
					<text fg={theme.text}>{"Install git hook for auto-indexing:"}</text>
				</box>
				<box paddingLeft={7}>
					<text fg={theme.valueBright}>{"mnemex hooks install"}</text>
				</box>
				{wizardState.runIndexAfterSave && (
					<box marginTop={2} paddingLeft={2}>
						<text fg={theme.muted}>{"Running mnemex index . now..."}</text>
					</box>
				)}
			</box>

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<text fg={theme.shortcutBracket}>{"["}</text>
				<text fg={theme.shortcutKey}>{"Enter"}</text>
				<text fg={theme.shortcutBracket}>{"]"}</text>
				<text fg={theme.muted}>{" exit setup"}</text>
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
