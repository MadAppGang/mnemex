/**
 * HardwareDetect — displays detected hardware and recommends models.
 *
 * Shows animated spinner when detection is in progress.
 * Keyboard: Enter to proceed.
 */

import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";
import { suggestModel, suggestAlternateModel } from "../hardware.js";
import type { HardwareProfile } from "../hardware.js";

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
// Spinner
// ============================================================================

const SPINNER_CHARS = ["/", "-", "\\", "|"];

// ============================================================================
// Component
// ============================================================================

export function HardwareDetectScreen({
	wizardState,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [spinnerIndex, setSpinnerIndex] = useState(0);

	// Animate spinner while detecting
	useEffect(() => {
		if (wizardState.hardware !== "detecting") return;

		const interval = setInterval(() => {
			setSpinnerIndex((prev) => (prev + 1) % SPINNER_CHARS.length);
		}, 150);

		return () => clearInterval(interval);
	}, [wizardState.hardware]);

	useKeyboard((key) => {
		if (wizardState.hardware === "detecting") return;

		if (key.name === "return" || key.name === "enter") {
			onNext();
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

	const isDetecting = wizardState.hardware === "detecting";
	const hw =
		wizardState.hardware !== "detecting" && wizardState.hardware !== null
			? (wizardState.hardware as HardwareProfile)
			: null;

	const spinner = SPINNER_CHARS[spinnerIndex] ?? "/";

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Hardware Detection "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Detecting state */}
			{isDetecting && (
				<box flexDirection="column" paddingLeft={3} paddingTop={3}>
					<box flexDirection="row">
						<text fg={theme.primary}>{`  ${spinner} `}</text>
						<text fg={theme.muted}>{"Detecting hardware..."}</text>
					</box>
					<box marginTop={1} paddingLeft={4}>
						<text fg={theme.dimmed}>
							{"Checking RAM, CPU, GPU, Ollama, LM Studio"}
						</text>
					</box>
				</box>
			)}

			{/* Hardware detected */}
			{hw && (
				<box flexDirection="column" paddingLeft={3} paddingTop={2}>
					<box>
						<text fg={theme.labelDim}>{"  Hardware Profile"}</text>
					</box>
					<box marginTop={1} flexDirection="row">
						<text fg={theme.labelDim}>{"  RAM       "}</text>
						<text
							fg={theme.valueBright}
						>{`${hw.totalRamGb.toFixed(1)} GB`}</text>
					</box>
					<box flexDirection="row">
						<text fg={theme.labelDim}>{"  CPU       "}</text>
						<text
							fg={theme.text}
						>{`${hw.cpuCores}x ${hw.cpuModel.slice(0, 40)}`}</text>
					</box>
					<box flexDirection="row">
						<text fg={theme.labelDim}>{"  GPU       "}</text>
						<text fg={theme.text}>
							{hw.gpuType === "apple-silicon"
								? `Apple Silicon${hw.gpuModel ? ` (${hw.gpuModel})` : ""}`
								: hw.gpuType === "nvidia"
									? `NVIDIA${hw.gpuModel ? ` ${hw.gpuModel}` : ""}`
									: hw.gpuType === "amd"
										? `AMD${hw.gpuModel ? ` ${hw.gpuModel}` : ""}`
										: hw.gpuType === "none"
											? "None detected"
											: "Unknown"}
						</text>
					</box>

					<box marginTop={1} flexDirection="row">
						<text fg={theme.labelDim}>{"  Ollama    "}</text>
						{hw.ollamaReachable ? (
							<box flexDirection="row">
								<text fg={theme.accentGreen}>{"[running]"}</text>
								<text fg={theme.dimmed}>{`  ${hw.ollamaEndpoint}`}</text>
							</box>
						) : (
							<text fg={theme.dimmed}>{"[not found]"}</text>
						)}
					</box>
					<box flexDirection="row">
						<text fg={theme.labelDim}>{"  LM Studio "}</text>
						{hw.lmstudioReachable ? (
							<box flexDirection="row">
								<text fg={theme.accentGreen}>{"[running]"}</text>
								<text fg={theme.dimmed}>{`  ${hw.lmstudioEndpoint}`}</text>
							</box>
						) : (
							<text fg={theme.dimmed}>{"[not found]"}</text>
						)}
					</box>

					{hw.ollamaModels.length > 0 && (
						<box flexDirection="column" marginTop={1}>
							<box>
								<text fg={theme.labelDim}>{"  Installed Ollama models:"}</text>
							</box>
							{hw.ollamaModels.slice(0, 5).map((m, i) => (
								<box key={i} paddingLeft={4} flexDirection="row">
									<text fg={theme.dimmed}>{"• "}</text>
									<text fg={theme.muted}>{m}</text>
								</box>
							))}
							{hw.ollamaModels.length > 5 && (
								<box paddingLeft={4}>
									<text
										fg={theme.dimmed}
									>{`  ... and ${hw.ollamaModels.length - 5} more`}</text>
								</box>
							)}
						</box>
					)}

					<box marginTop={2}>
						<text fg={theme.labelDim}>{"  Recommended embedding models:"}</text>
					</box>
					<box paddingLeft={4} flexDirection="row">
						<text fg={theme.accentGreen}>{"• "}</text>
						<text fg={theme.valueBright}>{suggestModel(hw)}</text>
						<text fg={theme.dimmed}>{"  (recommended)"}</text>
					</box>
					{suggestAlternateModel(hw) && (
						<box paddingLeft={4} flexDirection="row">
							<text fg={theme.dimmed}>{"• "}</text>
							<text fg={theme.muted}>{suggestAlternateModel(hw)}</text>
							<text fg={theme.dimmed}>{"  (alternative)"}</text>
						</box>
					)}
				</box>
			)}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				{!isDetecting && <ShortcutItem letter="Enter" label="continue" />}
				{!isDetecting && <ShortcutItem letter="Esc" label="back" />}
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
