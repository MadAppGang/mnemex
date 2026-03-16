/**
 * ModeSelect — deployment mode selection screen.
 *
 * Three modes: Local, Shared Instance, Full Cloud.
 * Keyboard: j/k or arrow keys, 1/2/3 for direct select, Enter to confirm, q to quit.
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { DeploymentMode, ScreenProps } from "../types.js";

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
// Mode Card Data
// ============================================================================

interface ModeCard {
	mode: DeploymentMode;
	title: string;
	subtitle: string;
	description: string;
	details: string[];
	art: string[];
}

const MODES: ModeCard[] = [
	{
		mode: "local",
		title: "Local",
		subtitle: "100% on-device",
		description: "All embeddings run on your machine via Ollama or LM Studio.",
		details: [
			"No data leaves your machine",
			"Works offline",
			"Requires Ollama or LM Studio",
			"Best for privacy-sensitive code",
		],
		art: [
			"  ┌──────────┐  ",
			"  │ [======] │  ",
			"  │ | code | │  ",
			"  │ [======] │  ",
			"  └────┬─────┘  ",
			"       │ local  ",
			"  [embeddings]  ",
		],
	},
	{
		mode: "shared",
		title: "Shared Instance",
		subtitle: "Team vector index, code stays local",
		description: "Source code stays local. Only embedding vectors are shared.",
		details: [
			"Code never leaves your machine",
			"Shared vector index for teams",
			"Requires cloud endpoint",
			"Best for team collaboration",
		],
		art: [
			"  ┌──────┐        ",
			"  │ code │ local  ",
			"  └──┬───┘        ",
			"     │ vectors    ",
			"  ┌──▼──────────┐ ",
			"  │ cloud index │ ",
			"  └─────────────┘ ",
		],
	},
	{
		mode: "full-cloud",
		title: "Full Cloud",
		subtitle: "Everything in the cloud",
		description: "Source code is transmitted to the cloud for indexing.",
		details: [
			"Code is sent to cloud server",
			"Best search quality",
			"No local GPU needed",
			"Requires cloud API key",
		],
		art: [
			"  ┌──────┐         ",
			"  │ code │──────►  ",
			"  └──────┘  cloud  ",
			"            ┌────┐ ",
			"            │ AI │ ",
			"            └────┘ ",
			"         [indexed] ",
		],
	},
];

// ============================================================================
// Component
// ============================================================================

export function ModeSelectScreen({
	wizardState,
	onUpdate,
	onNext,
	onQuit,
}: ScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState<number>(() => {
		if (wizardState.mode === "local") return 0;
		if (wizardState.mode === "shared") return 1;
		if (wizardState.mode === "full-cloud") return 2;
		return 0;
	});

	useKeyboard((key) => {
		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((prev) => Math.min(prev + 1, MODES.length - 1));
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
			const selected = MODES[selectedIndex];
			if (selected) {
				onUpdate({ mode: selected.mode });
				onNext();
			}
			return;
		}
		if (key.name === "q") {
			onQuit();
			return;
		}
	});

	const selected = MODES[selectedIndex];

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Choose Deployment Mode "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Mode list */}
			<box flexDirection="column" paddingLeft={3} paddingTop={2}>
				{MODES.map((card, i) => {
					const isSelected = i === selectedIndex;
					return (
						<box key={card.mode} flexDirection="column" marginBottom={1}>
							{/* Title row */}
							<box flexDirection="row">
								<text fg={isSelected ? theme.primary : theme.dimmed}>
									{isSelected ? "> " : "  "}
								</text>
								<text fg={isSelected ? theme.valueBright : theme.text}>
									{`[${i + 1}] ${card.title}`}
								</text>
								<text fg={theme.dimmed}>{`  — ${card.subtitle}`}</text>
							</box>

							{/* Description (only for selected) */}
							{isSelected && (
								<box flexDirection="column" paddingLeft={4} marginTop={1}>
									<box>
										<text fg={theme.text}>{card.description}</text>
									</box>
									{card.details.map((detail, di) => (
										<box key={di} flexDirection="row">
											<text fg={theme.accentGreen}>{"  • "}</text>
											<text fg={theme.muted}>{detail}</text>
										</box>
									))}
								</box>
							)}
						</box>
					);
				})}
			</box>

			{/* ASCII art for selected mode */}
			{selected && (
				<box flexDirection="column" paddingLeft={5} paddingTop={1}>
					{selected.art.map((line, i) => (
						<box key={i}>
							<text fg={theme.accentCyan}>{line}</text>
						</box>
					))}
				</box>
			)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<ShortcutItem letter="1/2/3" label="select" />
				<ShortcutItem letter="j/k" label="navigate" />
				<ShortcutItem letter="Enter" label="confirm" />
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
