/**
 * ModelSelect — embedding model selection screen.
 *
 * Three options: use recommended model, choose from installed, enter manually.
 * For "pull recommended", spawns `ollama pull` and streams progress.
 */

import { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { theme, scoreBarChars } from "../../theme.js";
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

function ProgressBar({ progress, width }: { progress: number; width: number }) {
	const filled = Math.round(progress * width);
	const empty = width - filled;
	const bar =
		scoreBarChars.filled.repeat(filled) + scoreBarChars.empty.repeat(empty);
	return <text fg={theme.accentGreen}>{bar}</text>;
}

// ============================================================================
// Sub-option types
// ============================================================================

type ModelSubOption = "recommended" | "installed" | "manual";

// ============================================================================
// Component
// ============================================================================

export function ModelSelectScreen({
	wizardState,
	onUpdate,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [subOption, setSubOption] = useState<ModelSubOption>("recommended");
	const [manualModel, setManualModel] = useState(wizardState.model);
	const [editingManual, setEditingManual] = useState(false);
	const [installedIndex, setInstalledIndex] = useState(0);
	const [pullProgress, setPullProgress] = useState<number>(0);
	const [isPulling, setIsPulling] = useState(false);
	const [pullError, setPullError] = useState<string | null>(null);
	const pullProcessRef = useRef<ChildProcess | null>(null);

	const hw =
		wizardState.hardware !== "detecting" && wizardState.hardware !== null
			? (wizardState.hardware as HardwareProfile)
			: null;

	const recommendedModel = hw ? suggestModel(hw) : "nomic-embed-text";
	const alternateModel = hw ? suggestAlternateModel(hw) : null;
	const installedModels = hw?.ollamaModels ?? [];

	// Cleanup pull process on unmount
	useEffect(() => {
		return () => {
			if (pullProcessRef.current) {
				pullProcessRef.current.kill("SIGTERM");
			}
		};
	}, []);

	const startPull = () => {
		if (isPulling) return;
		const model = recommendedModel;

		setIsPulling(true);
		setPullError(null);
		setPullProgress(0);
		onUpdate({ pullProgress: "starting...", pullComplete: false });

		const child = spawn("ollama", ["pull", model], { stdio: "pipe" });
		pullProcessRef.current = child;

		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				// Parse ollama pull progress output
				const progressMatch = trimmed.match(/(\d+)%/);
				if (progressMatch?.[1]) {
					const pct = parseInt(progressMatch[1], 10) / 100;
					setPullProgress(pct);
					onUpdate({ pullProgress: trimmed });
				} else if (trimmed.length > 0) {
					onUpdate({ pullProgress: trimmed });
				}
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			const msg = chunk.toString().trim();
			if (msg) {
				onUpdate({ pullProgress: msg });
			}
		});

		child.on("close", (code) => {
			pullProcessRef.current = null;
			setIsPulling(false);
			if (code === 0) {
				setPullProgress(1);
				onUpdate({
					model,
					pullProgress: null,
					pullComplete: true,
				});
			} else if (code !== null) {
				setPullError(`ollama pull exited with code ${code}`);
				onUpdate({ pullProgress: null });
			}
		});

		child.on("error", (err) => {
			pullProcessRef.current = null;
			setIsPulling(false);
			setPullError(err.message);
			onUpdate({ pullProgress: null });
		});
	};

	useKeyboard((key) => {
		// Manual entry mode
		if (editingManual) {
			if (key.name === "escape") {
				setEditingManual(false);
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				setEditingManual(false);
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				setManualModel((prev) => prev.slice(0, -1));
				return;
			}
			if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
				setManualModel((prev) => prev + key.sequence);
			}
			return;
		}

		// During pull
		if (isPulling) {
			if (key.name === "q" || key.name === "escape") {
				if (pullProcessRef.current) {
					pullProcessRef.current.kill("SIGTERM");
				}
				setIsPulling(false);
			}
			return;
		}

		if (key.name === "j" || key.name === "down") {
			if (subOption === "recommended") {
				setSubOption("installed");
			} else if (subOption === "installed") {
				if (installedIndex < installedModels.length - 1) {
					setInstalledIndex((prev) => prev + 1);
				} else {
					setSubOption("manual");
				}
			}
			return;
		}
		if (key.name === "k" || key.name === "up") {
			if (subOption === "manual") {
				setSubOption("installed");
			} else if (subOption === "installed") {
				if (installedIndex > 0) {
					setInstalledIndex((prev) => prev - 1);
				} else {
					setSubOption("recommended");
				}
			}
			return;
		}
		if (key.name === "1") {
			setSubOption("recommended");
			return;
		}
		if (key.name === "2") {
			setSubOption("installed");
			return;
		}
		if (key.name === "3") {
			setSubOption("manual");
			return;
		}
		if (key.name === "e" && subOption === "manual") {
			setEditingManual(true);
			return;
		}
		if (
			key.name === "p" &&
			subOption === "recommended" &&
			wizardState.provider === "ollama"
		) {
			startPull();
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			let model = "";
			if (subOption === "recommended") {
				model = recommendedModel;
			} else if (subOption === "installed") {
				model = installedModels[installedIndex] ?? recommendedModel;
			} else {
				model = manualModel.trim() || recommendedModel;
			}
			onUpdate({ model });
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

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Embedding Model "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			<box paddingLeft={3} paddingTop={1}>
				<text fg={theme.dimmed}>{"Choose an embedding model:"}</text>
			</box>

			<box flexDirection="column" paddingLeft={3} paddingTop={2}>
				{/* Option 1: Recommended */}
				<box flexDirection="column" marginBottom={1}>
					<box flexDirection="row">
						<text
							fg={subOption === "recommended" ? theme.primary : theme.dimmed}
						>
							{subOption === "recommended" ? "> " : "  "}
						</text>
						<text
							fg={subOption === "recommended" ? theme.valueBright : theme.text}
						>
							{"[1] Use recommended model"}
						</text>
					</box>
					{subOption === "recommended" && (
						<box flexDirection="column" paddingLeft={6}>
							<box flexDirection="row">
								<text fg={theme.accentGreen}>{"  • "}</text>
								<text fg={theme.valueBright}>{recommendedModel}</text>
								<text fg={theme.dimmed}>{"  (primary)"}</text>
							</box>
							{alternateModel && (
								<box flexDirection="row">
									<text fg={theme.dimmed}>{"  • "}</text>
									<text fg={theme.muted}>{alternateModel}</text>
									<text fg={theme.dimmed}>{"  (alternative)"}</text>
								</box>
							)}
							{wizardState.provider === "ollama" &&
								!wizardState.pullComplete && (
									<box marginTop={1} flexDirection="row">
										<text fg={theme.dimmed}>
											{"  Press [p] to pull model now, or [Enter] to skip"}
										</text>
									</box>
								)}
							{wizardState.pullComplete && (
								<box marginTop={1} flexDirection="row">
									<text fg={theme.accentGreen}>{"  [downloaded]"}</text>
								</box>
							)}
						</box>
					)}
				</box>

				{/* Pull progress */}
				{isPulling && (
					<box flexDirection="column" paddingLeft={6} marginBottom={1}>
						<box flexDirection="row">
							<text fg={theme.primary}>{"  Pulling "}</text>
							<text fg={theme.valueBright}>{recommendedModel}</text>
							<text fg={theme.muted}>{"..."}</text>
						</box>
						<box marginTop={1} flexDirection="row" paddingLeft={2}>
							<ProgressBar progress={pullProgress} width={30} />
							<text
								fg={theme.muted}
							>{`  ${Math.round(pullProgress * 100)}%`}</text>
						</box>
						{wizardState.pullProgress && (
							<box paddingLeft={2}>
								<text fg={theme.dimmed}>
									{wizardState.pullProgress.slice(0, 60)}
								</text>
							</box>
						)}
						<box marginTop={1}>
							<text fg={theme.dimmed}>{"  Press [q] or [Esc] to cancel"}</text>
						</box>
					</box>
				)}

				{pullError && (
					<box paddingLeft={6} marginBottom={1} flexDirection="row">
						<text fg={theme.error}>{"! "}</text>
						<text fg={theme.dangerText}>{pullError}</text>
					</box>
				)}

				{/* Option 2: Installed models */}
				<box flexDirection="column" marginBottom={1}>
					<box flexDirection="row">
						<text fg={subOption === "installed" ? theme.primary : theme.dimmed}>
							{subOption === "installed" ? "> " : "  "}
						</text>
						<text
							fg={subOption === "installed" ? theme.valueBright : theme.text}
						>
							{`[2] Choose from installed (${installedModels.length} models)`}
						</text>
					</box>
					{subOption === "installed" && installedModels.length > 0 && (
						<box flexDirection="column" paddingLeft={6}>
							{installedModels.slice(0, 8).map((m, i) => (
								<box key={m} flexDirection="row">
									<text
										fg={i === installedIndex ? theme.primary : theme.dimmed}
									>
										{i === installedIndex ? "  > " : "    "}
									</text>
									<text
										fg={i === installedIndex ? theme.valueBright : theme.muted}
									>
										{m}
									</text>
								</box>
							))}
						</box>
					)}
					{subOption === "installed" && installedModels.length === 0 && (
						<box paddingLeft={6}>
							<text fg={theme.dimmed}>{"No models installed"}</text>
						</box>
					)}
				</box>

				{/* Option 3: Manual entry */}
				<box flexDirection="column" marginBottom={1}>
					<box flexDirection="row">
						<text fg={subOption === "manual" ? theme.primary : theme.dimmed}>
							{subOption === "manual" ? "> " : "  "}
						</text>
						<text fg={subOption === "manual" ? theme.valueBright : theme.text}>
							{"[3] Enter model name manually"}
						</text>
					</box>
					{subOption === "manual" && (
						<box
							flexDirection="column"
							marginTop={1}
							marginLeft={4}
							borderStyle="single"
							borderColor={
								manualModel.length > 0 ? theme.primary : theme.border
							}
							paddingLeft={2}
							paddingRight={2}
							paddingTop={1}
							paddingBottom={1}
						>
							<box flexDirection="row">
								<text fg={theme.labelDim}>{"model name  "}</text>
								<text fg={theme.valueBright}>{manualModel}</text>
								{editingManual && <text fg={theme.primary}>{"_"}</text>}
							</box>
							{!editingManual && (
								<box marginTop={1}>
									<text fg={theme.dimmed}>{"Press [e] to edit"}</text>
								</box>
							)}
						</box>
					)}
				</box>
			</box>

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Footer */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				{!isPulling && <ShortcutItem letter="Enter" label="confirm" />}
				{!isPulling && <ShortcutItem letter="Esc" label="back" />}
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
