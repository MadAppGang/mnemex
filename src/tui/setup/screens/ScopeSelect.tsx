/**
 * ScopeSelect — config file scope selection screen.
 *
 * Options: Global only, Project only, Both.
 * Shows merge vs. overwrite notice when project config exists.
 * Keyboard: j/k, 1/2/3, Enter, Esc, q
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ConfigScope, ScreenProps } from "../types.js";

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

// ============================================================================
// Scope Options
// ============================================================================

interface ScopeOption {
	scope: ConfigScope;
	label: string;
	description: string;
	files: string[];
}

const SCOPES: ScopeOption[] = [
	{
		scope: "global",
		label: "Global only",
		description: "Apply settings to all projects on this machine.",
		files: ["~/.mnemex/config.json"],
	},
	{
		scope: "project",
		label: "Project only",
		description: "Apply settings to the current project only.",
		files: [".mnemex/config.json"],
	},
	{
		scope: "both",
		label: "Both (global + project)",
		description: "Write global defaults and per-project overrides.",
		files: ["~/.mnemex/config.json", ".mnemex/config.json"],
	},
];

// ============================================================================
// Component
// ============================================================================

export function ScopeSelectScreen({
	wizardState,
	onUpdate,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState<number>(() => {
		if (wizardState.scope === "global") return 0;
		if (wizardState.scope === "project") return 1;
		if (wizardState.scope === "both") return 2;
		return 0;
	});

	useKeyboard((key) => {
		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((prev) => Math.min(prev + 1, SCOPES.length - 1));
			return;
		}
		if (key.name === "k" || key.name === "up") {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
			return;
		}
		if (key.name === "1") {
			setSelectedIndex(0);
			return;
		}
		if (key.name === "2") {
			setSelectedIndex(1);
			return;
		}
		if (key.name === "3") {
			setSelectedIndex(2);
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			const selected = SCOPES[selectedIndex];
			if (selected) {
				onUpdate({ scope: selected.scope });
				onNext();
			}
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

	const selected = SCOPES[selectedIndex];

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Configuration Scope "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			<box paddingLeft={3} paddingTop={1}>
				<text fg={theme.dimmed}>
					{"Where should the configuration be saved?"}
				</text>
			</box>

			{/* Scope list */}
			<box flexDirection="column" paddingLeft={3} paddingTop={2}>
				{SCOPES.map((opt, i) => {
					const isSelected = i === selectedIndex;
					return (
						<box key={opt.scope} flexDirection="column" marginBottom={1}>
							<box flexDirection="row">
								<text fg={isSelected ? theme.primary : theme.dimmed}>
									{isSelected ? "> " : "  "}
								</text>
								<text fg={isSelected ? theme.valueBright : theme.text}>
									{`[${i + 1}] ${opt.label}`}
								</text>
							</box>
							{isSelected && (
								<box flexDirection="column" paddingLeft={6}>
									<box>
										<text fg={theme.dimmed}>{opt.description}</text>
									</box>
									<box marginTop={1}>
										<text fg={theme.labelDim}>{"Files to write:"}</text>
									</box>
									{opt.files.map((f, fi) => (
										<box key={fi} flexDirection="row">
											<text fg={theme.accentCyan}>{"  • "}</text>
											<text fg={theme.muted}>{f}</text>
										</box>
									))}
								</box>
							)}
						</box>
					);
				})}
			</box>

			{/* Merge notice */}
			{wizardState.projectConfigExists &&
				selected &&
				(selected.scope === "project" || selected.scope === "both") && (
					<box
						flexDirection="column"
						paddingLeft={3}
						paddingTop={1}
						marginLeft={2}
						borderStyle="single"
						borderColor={theme.warning}
						paddingRight={2}
						paddingBottom={1}
					>
						<box flexDirection="row">
							<text fg={theme.warning}>{"! "}</text>
							<text fg={theme.dangerText}>
								{"Existing project config found"}
							</text>
						</box>
						<box>
							<text fg={theme.muted}>
								{"Settings will be merged with existing values."}
							</text>
						</box>
					</box>
				)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<ShortcutItem letter="1/2/3" label="select" />
				<ShortcutItem letter="Enter" label="confirm" />
				<ShortcutItem letter="Esc" label="back" />
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
