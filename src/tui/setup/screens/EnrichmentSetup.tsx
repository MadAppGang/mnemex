/**
 * EnrichmentSetup — LLM enrichment configuration screen.
 *
 * Options: cc/sonnet, Anthropic API, OpenRouter, Ollama, LM Studio, Custom, Skip.
 * API key input appears for Anthropic and OpenRouter options.
 */

import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.js";
import type { ScreenProps } from "../types.js";

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
// Enrichment Options
// ============================================================================

interface EnrichmentOption {
	id: string;
	llmSpec: string | null;
	label: string;
	description: string;
	requiresApiKey: boolean;
	apiKeyPrefix?: string;
	apiKeyLabel?: string;
	requiresEndpoint?: boolean;
}

const ENRICHMENT_OPTIONS: EnrichmentOption[] = [
	{
		id: "cc-sonnet",
		llmSpec: "cc/sonnet",
		label: "Claude Code (cc/sonnet)",
		description: "Use Claude Code subscription — no API key needed",
		requiresApiKey: false,
	},
	{
		id: "anthropic",
		llmSpec: "a/sonnet",
		label: "Anthropic API",
		description: "Direct Anthropic API access",
		requiresApiKey: true,
		apiKeyPrefix: "sk-ant-",
		apiKeyLabel: "Anthropic API key",
	},
	{
		id: "openrouter",
		llmSpec: "or/openai/gpt-4o",
		label: "OpenRouter",
		description: "Access 100s of models via OpenRouter API",
		requiresApiKey: true,
		apiKeyPrefix: "sk-or-",
		apiKeyLabel: "OpenRouter API key",
	},
	{
		id: "ollama-llm",
		llmSpec: "ol/llama3",
		label: "Ollama (local LLM)",
		description: "Use a local LLM via Ollama for enrichment",
		requiresApiKey: false,
		requiresEndpoint: true,
	},
	{
		id: "lmstudio-llm",
		llmSpec: "ls/local",
		label: "LM Studio (local LLM)",
		description: "Use a local LLM via LM Studio for enrichment",
		requiresApiKey: false,
		requiresEndpoint: true,
	},
	{
		id: "custom",
		llmSpec: "custom",
		label: "Custom endpoint",
		description: "Any OpenAI-compatible LLM endpoint",
		requiresApiKey: false,
		requiresEndpoint: true,
	},
	{
		id: "skip",
		llmSpec: null,
		label: "Skip enrichment",
		description: "Disable LLM-powered code summaries",
		requiresApiKey: false,
	},
];

// ============================================================================
// Component
// ============================================================================

export function EnrichmentSetupScreen({
	wizardState,
	onUpdate,
	onNext,
	onBack,
	onQuit,
}: ScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState<number>(() => {
		if (wizardState.enrichmentSkipped) return ENRICHMENT_OPTIONS.length - 1;
		if (wizardState.llm === "cc/sonnet") return 0;
		if (wizardState.llm === "a/sonnet") return 1;
		if (wizardState.llm?.startsWith("or/")) return 2;
		return 0;
	});
	const [apiKey, setApiKey] = useState(wizardState.llmApiKey ?? "");
	const [endpoint, setEndpoint] = useState(wizardState.llmEndpoint ?? "");
	const [editField, setEditField] = useState<"none" | "apikey" | "endpoint">(
		"none",
	);
	const [keyError, setKeyError] = useState<string | null>(null);

	const selectedOpt = ENRICHMENT_OPTIONS[selectedIndex];

	useKeyboard((key) => {
		// Field editing modes
		if (editField !== "none") {
			if (key.name === "escape") {
				setEditField("none");
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				// Validate API key prefix
				if (editField === "apikey" && selectedOpt?.apiKeyPrefix) {
					if (
						apiKey.length > 0 &&
						!apiKey.startsWith(selectedOpt.apiKeyPrefix)
					) {
						setKeyError(`Key should start with ${selectedOpt.apiKeyPrefix}`);
					} else {
						setKeyError(null);
					}
				}
				setEditField("none");
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				if (editField === "apikey") {
					setApiKey((prev) => prev.slice(0, -1));
				} else {
					setEndpoint((prev) => prev.slice(0, -1));
				}
				setKeyError(null);
				return;
			}
			if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
				if (editField === "apikey") {
					setApiKey((prev) => prev + key.sequence);
				} else {
					setEndpoint((prev) => prev + key.sequence);
				}
			}
			return;
		}

		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((prev) =>
				Math.min(prev + 1, ENRICHMENT_OPTIONS.length - 1),
			);
			return;
		}
		if (key.name === "k" || key.name === "up") {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
			return;
		}

		// Number shortcuts for first 7 options
		const numKey = parseInt(key.name ?? "", 10);
		if (!isNaN(numKey) && numKey >= 1 && numKey <= ENRICHMENT_OPTIONS.length) {
			setSelectedIndex(numKey - 1);
			return;
		}

		if (key.name === "a" && selectedOpt?.requiresApiKey) {
			setEditField("apikey");
			return;
		}
		if (key.name === "e" && selectedOpt?.requiresEndpoint) {
			setEditField("endpoint");
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			if (!selectedOpt) return;

			// Validate API key if required
			if (selectedOpt.requiresApiKey && selectedOpt.apiKeyPrefix) {
				if (apiKey.length > 0 && !apiKey.startsWith(selectedOpt.apiKeyPrefix)) {
					setKeyError(`Key should start with ${selectedOpt.apiKeyPrefix}`);
					return;
				}
			}

			if (selectedOpt.id === "skip") {
				onUpdate({ enrichmentSkipped: true, llm: null, llmApiKey: null });
			} else {
				onUpdate({
					enrichmentSkipped: false,
					llm: selectedOpt.llmSpec,
					llmApiKey: apiKey.length > 0 ? apiKey : null,
					llmEndpoint: endpoint.length > 0 ? endpoint : null,
				});
			}
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

	// Masked API key display
	const maskedKey =
		apiKey.length > 0
			? apiKey.length > 8
				? `${apiKey.slice(0, 6)}${"*".repeat(Math.min(apiKey.length - 6, 12))}`
				: "*".repeat(apiKey.length)
			: "";

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" mnemex "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" Setup "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{" LLM Enrichment "}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			<box paddingLeft={3} paddingTop={1}>
				<text fg={theme.dimmed}>
					{"Choose an LLM provider for code summaries:"}
				</text>
			</box>

			{/* Options list */}
			<box flexDirection="column" paddingLeft={3} paddingTop={1}>
				{ENRICHMENT_OPTIONS.map((opt, i) => {
					const isSelected = i === selectedIndex;
					return (
						<box key={opt.id} flexDirection="column" marginBottom={1}>
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

									{/* API key input */}
									{opt.requiresApiKey && (
										<box
											flexDirection="column"
											marginTop={1}
											borderStyle="single"
											borderColor={
												apiKey.length > 0 ? theme.primary : theme.border
											}
											paddingLeft={2}
											paddingRight={2}
											paddingTop={1}
											paddingBottom={1}
										>
											<box flexDirection="row">
												<text
													fg={theme.labelDim}
												>{`${opt.apiKeyLabel ?? "API key"}  `}</text>
												<text fg={theme.secretBright}>{maskedKey}</text>
												{editField === "apikey" && (
													<text fg={theme.primary}>{"_"}</text>
												)}
											</box>
											{!editField && (
												<box marginTop={1}>
													<text fg={theme.dimmed}>
														{"Press [a] to enter API key"}
													</text>
												</box>
											)}
											{keyError && (
												<box marginTop={1} flexDirection="row">
													<text fg={theme.error}>{"! "}</text>
													<text fg={theme.dangerText}>{keyError}</text>
												</box>
											)}
										</box>
									)}

									{/* Endpoint input */}
									{opt.requiresEndpoint && (
										<box
											flexDirection="column"
											marginTop={1}
											borderStyle="single"
											borderColor={
												endpoint.length > 0 ? theme.primary : theme.border
											}
											paddingLeft={2}
											paddingRight={2}
											paddingTop={1}
											paddingBottom={1}
										>
											<box flexDirection="row">
												<text fg={theme.labelDim}>{"endpoint  "}</text>
												<text fg={theme.valueBright}>{endpoint}</text>
												{editField === "endpoint" && (
													<text fg={theme.primary}>{"_"}</text>
												)}
											</box>
											{!editField && (
												<box marginTop={1}>
													<text fg={theme.dimmed}>
														{"Press [e] to edit endpoint"}
													</text>
												</box>
											)}
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
				<ShortcutItem letter="1-7" label="select" />
				<ShortcutItem letter="Enter" label="confirm" />
				<ShortcutItem letter="Esc" label="back" />
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
