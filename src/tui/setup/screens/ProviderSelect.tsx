/**
 * ProviderSelect — embedding provider selection screen.
 *
 * Options: Ollama, LM Studio, Custom HTTP URL.
 * Shows reachability badge based on hardware detection.
 * Keyboard: j/k, 1/2/3, Enter, Esc, q
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { EmbeddingProvider } from "../../../types.js";
import type { ScreenProps } from "../types.js";
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
// Provider Options
// ============================================================================

interface ProviderOption {
	provider: EmbeddingProvider;
	label: string;
	description: string;
	hasCustomUrl: boolean;
}

const PROVIDERS: ProviderOption[] = [
	{
		provider: "ollama",
		label: "Ollama",
		description: "Local LLM server, free and open source",
		hasCustomUrl: false,
	},
	{
		provider: "lmstudio",
		label: "LM Studio",
		description: "User-friendly local model runner with GUI",
		hasCustomUrl: false,
	},
	{
		provider: "local",
		label: "Custom HTTP Endpoint",
		description: "Any OpenAI-compatible embedding endpoint",
		hasCustomUrl: true,
	},
];

// ============================================================================
// Component
// ============================================================================

export function ProviderSelectScreen({
	wizardState,
	onUpdate,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState<number>(() => {
		if (wizardState.provider === "ollama") return 0;
		if (wizardState.provider === "lmstudio") return 1;
		if (wizardState.provider === "local") return 2;
		return 0;
	});
	const [customUrl, setCustomUrl] = useState(wizardState.localEndpoint);
	const [editingUrl, setEditingUrl] = useState(false);

	const hw =
		wizardState.hardware !== "detecting" && wizardState.hardware !== null
			? (wizardState.hardware as HardwareProfile)
			: null;

	useKeyboard((key) => {
		// URL editing mode
		if (editingUrl) {
			if (key.name === "escape") {
				setEditingUrl(false);
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				setEditingUrl(false);
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				setCustomUrl((prev) => prev.slice(0, -1));
				return;
			}
			if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
				setCustomUrl((prev) => prev + key.sequence);
			}
			return;
		}

		// Navigation mode
		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((prev) => Math.min(prev + 1, PROVIDERS.length - 1));
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
		if (key.name === "e" && PROVIDERS[selectedIndex]?.hasCustomUrl) {
			setEditingUrl(true);
			return;
		}
		if (key.name === "return" || key.name === "enter") {
			const selected = PROVIDERS[selectedIndex];
			if (selected) {
				const updates: Partial<typeof wizardState> = {
					provider: selected.provider,
				};
				if (selected.provider === "local") {
					updates.localEndpoint = customUrl;
				}
				onUpdate(updates);
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

	const getReachabilityBadge = (provider: EmbeddingProvider) => {
		if (!hw) return null;
		if (provider === "ollama") {
			return hw.ollamaReachable ? (
				<text fg={theme.accentGreen}>{" [running]"}</text>
			) : (
				<text fg={theme.dimmed}>{" [not found]"}</text>
			);
		}
		if (provider === "lmstudio") {
			return hw.lmstudioReachable ? (
				<text fg={theme.accentGreen}>{" [running]"}</text>
			) : (
				<text fg={theme.dimmed}>{" [not found]"}</text>
			);
		}
		return null;
	};

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" Embedding Provider "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			<box paddingLeft={3} paddingTop={1}>
				<text fg={theme.dimmed}>
					{"Select the embedding provider for local indexing:"}
				</text>
			</box>

			{/* Provider list */}
			<box flexDirection="column" paddingLeft={3} paddingTop={2}>
				{PROVIDERS.map((opt, i) => {
					const isSelected = i === selectedIndex;
					return (
						<box key={opt.provider} flexDirection="column" marginBottom={1}>
							<box flexDirection="row">
								<text fg={isSelected ? theme.primary : theme.dimmed}>
									{isSelected ? "> " : "  "}
								</text>
								<text fg={isSelected ? theme.valueBright : theme.text}>
									{`[${i + 1}] ${opt.label}`}
								</text>
								{getReachabilityBadge(opt.provider)}
							</box>
							{isSelected && (
								<box paddingLeft={6}>
									<text fg={theme.dimmed}>{opt.description}</text>
								</box>
							)}
							{isSelected && opt.hasCustomUrl && (
								<box
									flexDirection="column"
									marginTop={1}
									marginLeft={4}
									borderStyle="single"
									borderColor={
										customUrl.length > 0 ? theme.primary : theme.border
									}
									paddingLeft={2}
									paddingRight={2}
									paddingTop={1}
									paddingBottom={1}
								>
									<box flexDirection="row">
										<text fg={theme.labelDim}>{"endpoint  "}</text>
										<text fg={theme.valueBright}>{customUrl}</text>
										{editingUrl && <text fg={theme.primary}>{"_"}</text>}
									</box>
									{!editingUrl && (
										<box marginTop={1}>
											<text fg={theme.dimmed}>{"Press [e] to edit URL"}</text>
										</box>
									)}
								</box>
							)}
						</box>
					);
				})}
			</box>

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
