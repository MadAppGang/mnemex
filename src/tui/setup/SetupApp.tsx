/**
 * SetupApp — root wizard component with state machine and history stack.
 *
 * Manages WizardState, history stack, and renders current screen.
 * Background hardware detection via useEffect on mount.
 */

import { useState, useEffect, useCallback } from "react";
import type { GlobalConfig, ProjectConfig } from "../../types.js";
import type { TeamConfig } from "../../cloud/types.js";
import {
	loadGlobalConfig,
	loadProjectConfig,
	saveGlobalConfig,
	saveProjectConfig,
} from "../../config.js";
import {
	DEFAULT_WIZARD_STATE,
	type WizardState,
	type WizardStep,
} from "./types.js";
import { detectHardware } from "./hardware.js";
import { ModeSelectScreen } from "./screens/ModeSelect.js";
import { HardwareDetectScreen } from "./screens/HardwareDetect.js";
import { ProviderSelectScreen } from "./screens/ProviderSelect.js";
import { ModelSelectScreen } from "./screens/ModelSelect.js";
import { ScopeSelectScreen } from "./screens/ScopeSelect.js";
import { ReviewScreen } from "./screens/Review.js";
import { CompleteScreen } from "./screens/Complete.js";
import { CloudWarningScreen } from "./screens/CloudWarning.js";
import { CloudSetupScreen } from "./screens/CloudSetup.js";
import { EnrichmentSetupScreen } from "./screens/EnrichmentSetup.js";

// ============================================================================
// Types
// ============================================================================

export interface SetupAppProps {
	quit: () => void;
	initialMode?: "local" | "shared" | "full-cloud";
}

interface BuildConfigResult {
	globalPart: Partial<GlobalConfig>;
	projectPart: Partial<ProjectConfig> | null;
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Resolve the next wizard step based on current step and state.
 */
function resolveNextStep(
	current: WizardStep,
	state: WizardState,
): WizardStep {
	switch (current) {
		case "mode-select":
			if (state.mode === "local") return "hardware-detect";
			if (state.mode === "shared") return "cloud-setup";
			if (state.mode === "full-cloud") return "cloud-warning";
			return "hardware-detect";

		case "hardware-detect":
			return "provider-select";

		case "provider-select":
			return "model-select";

		case "model-select":
			return "enrichment-setup";

		case "cloud-warning":
			return "cloud-setup";

		case "cloud-setup":
			if (state.mode === "full-cloud") return "enrichment-setup";
			return "provider-select"; // shared: still needs local embedding provider

		case "enrichment-setup":
			return "scope-select";

		case "scope-select":
			return "review";

		case "review":
			return "saving";

		case "saving":
			return "done";

		default:
			return "done";
	}
}

/**
 * Convert WizardState into GlobalConfig + ProjectConfig parts.
 */
function buildConfigs(state: WizardState): BuildConfigResult {
	const globalPart: Partial<GlobalConfig> = {};
	const projectPart: Partial<ProjectConfig> | null =
		state.scope === "global" ? null : {};

	// Embedding provider
	if (state.provider) {
		globalPart.embeddingProvider = state.provider;
	}
	if (state.provider === "ollama") {
		globalPart.ollamaEndpoint = state.ollamaEndpoint;
		globalPart.defaultModel = state.model || undefined;
	}
	if (state.provider === "lmstudio") {
		globalPart.lmstudioEndpoint = state.lmstudioEndpoint;
		globalPart.defaultModel = state.model || undefined;
	}
	if (state.provider === "local") {
		globalPart.localEndpoint = state.localEndpoint || undefined;
		globalPart.defaultModel = state.model || undefined;
	}

	// Enrichment
	if (state.enrichmentSkipped) {
		globalPart.enableEnrichment = false;
	} else if (state.llm) {
		globalPart.llm = state.llm;
		globalPart.enableEnrichment = true;
		if (state.llm.startsWith("a/") && state.llmApiKey) {
			globalPart.anthropicApiKey = state.llmApiKey;
		}
		if (state.llm.startsWith("or/") && state.llmApiKey) {
			globalPart.openrouterApiKey = state.llmApiKey;
		}
		if (state.llmEndpoint) {
			globalPart.llmEndpoint = state.llmEndpoint;
		}
	}

	// Cloud / Team
	if (state.mode === "shared" || state.mode === "full-cloud") {
		const teamConfig: TeamConfig = {
			orgSlug: state.orgSlug,
			repoSlug: state.repoSlug || undefined,
			cloudEndpoint: state.cloudEndpoint || undefined,
			cloudMode: state.mode === "full-cloud" ? "smart" : "thin",
		};
		// Always persist the cloud API key to global config so authentication
		// works regardless of scope selection.
		if (state.cloudApiKey) {
			globalPart.cloudApiKey = state.cloudApiKey;
		}
		if (projectPart !== null) {
			// Project or "both" scope: write team config to project config.
			projectPart.team = teamConfig;
		} else {
			// Global-only scope: write team config to global config so that
			// cloud/team settings are not silently discarded.
			globalPart.team = teamConfig;
		}
	}

	return { globalPart, projectPart };
}

/**
 * Pre-fill wizard state from existing configs (reconfigure flow).
 */
function prefillFromExistingConfig(base: WizardState): WizardState {
	const globalConfig = loadGlobalConfig();
	const projectConfig = loadProjectConfig(process.cwd());

	const updated: WizardState = { ...base };

	if (globalConfig.embeddingProvider) {
		updated.provider = globalConfig.embeddingProvider;
	}
	if (globalConfig.ollamaEndpoint) {
		updated.ollamaEndpoint = globalConfig.ollamaEndpoint;
	}
	if (globalConfig.lmstudioEndpoint) {
		updated.lmstudioEndpoint = globalConfig.lmstudioEndpoint;
	}
	if (globalConfig.localEndpoint) {
		updated.localEndpoint = globalConfig.localEndpoint;
	}
	if (globalConfig.defaultModel) {
		updated.model = globalConfig.defaultModel;
	}
	if (globalConfig.llm) {
		updated.llm = globalConfig.llm;
	}
	if (globalConfig.enableEnrichment === false) {
		updated.enrichmentSkipped = true;
	}
	if (globalConfig.anthropicApiKey) {
		updated.llmApiKey = globalConfig.anthropicApiKey;
	}
	if (globalConfig.llmEndpoint) {
		updated.llmEndpoint = globalConfig.llmEndpoint;
	}

	if (projectConfig?.team) {
		const team = projectConfig.team;
		updated.cloudEndpoint = team.cloudEndpoint ?? base.cloudEndpoint;
		updated.orgSlug = team.orgSlug;
		updated.repoSlug = team.repoSlug ?? "";
		updated.mode = team.cloudMode === "smart" ? "full-cloud" : "shared";
	}

	if (projectConfig) {
		updated.projectConfigExists = true;
	}

	return updated;
}

// ============================================================================
// Component
// ============================================================================

export function SetupApp({ quit, initialMode }: SetupAppProps) {
	const [wizardState, setWizardState] = useState<WizardState>(() => {
		const base = prefillFromExistingConfig(DEFAULT_WIZARD_STATE);
		if (initialMode) {
			return { ...base, mode: initialMode };
		}
		return base;
	});
	const [history, setHistory] = useState<WizardStep[]>(() => {
		if (initialMode) {
			// Skip mode-select, go directly to the first step for this mode
			const firstStep = resolveNextStep("mode-select", {
				...DEFAULT_WIZARD_STATE,
				mode: initialMode,
			});
			return [firstStep];
		}
		return ["mode-select"];
	});
	const [saveError, setSaveError] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);

	const currentStep = history[history.length - 1] ?? "mode-select";

	// Background hardware detection when entering hardware-detect screen
	useEffect(() => {
		if (currentStep !== "hardware-detect") return;
		if (wizardState.hardware !== null) return;

		setWizardState((prev) => ({ ...prev, hardware: "detecting" }));

		detectHardware()
			.then((hw) => {
				setWizardState((prev) => ({ ...prev, hardware: hw }));
			})
			.catch(() => {
				// Graceful fallback: unknown hardware
				setWizardState((prev) => ({
					...prev,
					hardware: {
						totalRamGb: 8,
						cpuModel: "Unknown",
						cpuCores: 4,
						gpuType: "unknown",
						ollamaReachable: false,
						ollamaEndpoint: "http://localhost:11434",
						ollamaModels: [],
						lmstudioReachable: false,
						lmstudioEndpoint: "http://localhost:1234/v1",
					},
				}));
			});
	}, [currentStep]);

	const handleUpdate = useCallback((partial: Partial<WizardState>) => {
		setWizardState((prev) => ({ ...prev, ...partial }));
	}, []);

	const handleNext = useCallback(
		(override?: WizardStep) => {
			const next = override ?? resolveNextStep(currentStep, wizardState);
			setHistory((prev) => [...prev, next]);
		},
		[currentStep, wizardState],
	);

	const handleBack = useCallback(() => {
		setHistory((prev) => {
			if (prev.length <= 1) return prev;
			return prev.slice(0, -1);
		});
	}, []);

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setSaveError(null);

		try {
			const { globalPart, projectPart } = buildConfigs(wizardState);
			saveGlobalConfig(globalPart);

			if (projectPart !== null) {
				saveProjectConfig(process.cwd(), projectPart);
			}

			// Navigate to done
			setHistory((prev) => [...prev, "done"]);
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSaving(false);
		}
	}, [wizardState]);

	const screenProps = {
		wizardState,
		onUpdate: handleUpdate,
		onNext: handleNext,
		onBack: handleBack,
		onQuit: quit,
	};

	// Render current screen
	switch (currentStep) {
		case "mode-select":
			return <ModeSelectScreen {...screenProps} />;

		case "hardware-detect":
			return <HardwareDetectScreen {...screenProps} />;

		case "provider-select":
			return <ProviderSelectScreen {...screenProps} />;

		case "model-select":
			return <ModelSelectScreen {...screenProps} />;

		case "cloud-warning":
			return <CloudWarningScreen {...screenProps} />;

		case "cloud-setup":
			return <CloudSetupScreen {...screenProps} />;

		case "enrichment-setup":
			return <EnrichmentSetupScreen {...screenProps} />;

		case "scope-select":
			return <ScopeSelectScreen {...screenProps} />;

		case "review":
			return (
				<ReviewScreen
					{...screenProps}
					onSave={handleSave}
					saveError={saveError}
					isSaving={isSaving}
				/>
			);

		case "saving":
		case "done":
			return <CompleteScreen {...screenProps} />;

		default:
			return <ModeSelectScreen {...screenProps} />;
	}
}
