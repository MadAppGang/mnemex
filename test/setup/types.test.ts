/**
 * Black Box Tests: Wizard Types and Step Logic — types.ts
 *
 * Tests are based exclusively on requirements (requirements.md) and
 * the public API contract (architecture.md §1.4, §5.4 + types.ts).
 *
 * Requirements tested:
 *   FR-21: Step indicator ("Step X of Y") logic
 *   Architecture §1.4: WizardStep union, state machine transition step lists
 *   Architecture §5.4: STEP_LISTS per deployment mode
 *   Architecture §3.1: DEFAULT_WIZARD_STATE initial values
 */

import { describe, it, expect } from "bun:test";
import {
	STEP_LISTS,
	DEFAULT_WIZARD_STATE,
	getStepLabel,
	type WizardStep,
	type DeploymentMode,
	type ConfigScope,
	type WizardState,
} from "../../src/tui/setup/types.js";

// ============================================================================
// STEP_LISTS — mode to ordered screen list
// ============================================================================

describe("STEP_LISTS", () => {
	it("local step list has the correct ordered steps (TEST-21)", () => {
		expect(STEP_LISTS.local).toEqual([
			"mode-select",
			"hardware-detect",
			"provider-select",
			"model-select",
			"enrichment-setup",
			"scope-select",
			"review",
		]);
	});

	it("shared step list has the correct ordered steps (TEST-22)", () => {
		expect(STEP_LISTS.shared).toEqual([
			"mode-select",
			"cloud-setup",
			"provider-select",
			"model-select",
			"enrichment-setup",
			"scope-select",
			"review",
		]);
	});

	it("full-cloud step list has the correct ordered steps (TEST-23)", () => {
		expect(STEP_LISTS["full-cloud"]).toEqual([
			"mode-select",
			"cloud-warning",
			"cloud-setup",
			"enrichment-setup",
			"scope-select",
			"review",
		]);
	});

	it("local step list starts with mode-select", () => {
		expect(STEP_LISTS.local[0]).toBe("mode-select");
	});

	it("shared step list starts with mode-select", () => {
		expect(STEP_LISTS.shared[0]).toBe("mode-select");
	});

	it("full-cloud step list starts with mode-select", () => {
		expect(STEP_LISTS["full-cloud"][0]).toBe("mode-select");
	});

	it("all step lists end with review", () => {
		expect(STEP_LISTS.local.at(-1)).toBe("review");
		expect(STEP_LISTS.shared.at(-1)).toBe("review");
		expect(STEP_LISTS["full-cloud"].at(-1)).toBe("review");
	});

	it("local step list contains hardware-detect (local-only step)", () => {
		expect(STEP_LISTS.local).toContain("hardware-detect");
	});

	it("shared step list does NOT contain hardware-detect", () => {
		expect(STEP_LISTS.shared).not.toContain("hardware-detect");
	});

	it("full-cloud step list does NOT contain hardware-detect", () => {
		expect(STEP_LISTS["full-cloud"]).not.toContain("hardware-detect");
	});

	it("full-cloud step list contains cloud-warning (full-cloud only step)", () => {
		expect(STEP_LISTS["full-cloud"]).toContain("cloud-warning");
	});

	it("local step list does NOT contain cloud-warning", () => {
		expect(STEP_LISTS.local).not.toContain("cloud-warning");
	});

	it("shared step list does NOT contain cloud-warning", () => {
		expect(STEP_LISTS.shared).not.toContain("cloud-warning");
	});

	it("all step lists contain enrichment-setup (all modes include enrichment)", () => {
		expect(STEP_LISTS.local).toContain("enrichment-setup");
		expect(STEP_LISTS.shared).toContain("enrichment-setup");
		expect(STEP_LISTS["full-cloud"]).toContain("enrichment-setup");
	});

	it("all step lists contain scope-select (all modes include scope)", () => {
		expect(STEP_LISTS.local).toContain("scope-select");
		expect(STEP_LISTS.shared).toContain("scope-select");
		expect(STEP_LISTS["full-cloud"]).toContain("scope-select");
	});

	it("full-cloud list has 6 steps", () => {
		expect(STEP_LISTS["full-cloud"].length).toBe(6);
	});

	it("local list has 7 steps", () => {
		expect(STEP_LISTS.local.length).toBe(7);
	});

	it("shared list has 7 steps", () => {
		expect(STEP_LISTS.shared.length).toBe(7);
	});
});

// ============================================================================
// getStepLabel() — step indicator text
// ============================================================================

describe("getStepLabel()", () => {
	it("returns 'Step 1 of 5' when mode is null (pre-selection) (TEST-24)", () => {
		expect(getStepLabel("mode-select", null)).toBe("Step 1 of 5");
	});

	it("returns correct step label for local mode first step (TEST-25)", () => {
		// local list has 7 items, mode-select is index 0 → Step 1 of 7
		expect(getStepLabel("mode-select", "local")).toBe("Step 1 of 7");
	});

	it("returns correct step label for local mode hardware-detect (TEST-26)", () => {
		// local list: hardware-detect is index 1 → Step 2 of 7
		expect(getStepLabel("hardware-detect", "local")).toBe("Step 2 of 7");
	});

	it("returns correct step label for local mode provider-select (step 3)", () => {
		expect(getStepLabel("provider-select", "local")).toBe("Step 3 of 7");
	});

	it("returns correct step label for local mode model-select (step 4)", () => {
		expect(getStepLabel("model-select", "local")).toBe("Step 4 of 7");
	});

	it("returns correct step label for local mode enrichment-setup (step 5)", () => {
		expect(getStepLabel("enrichment-setup", "local")).toBe("Step 5 of 7");
	});

	it("returns correct step label for local mode scope-select (step 6)", () => {
		expect(getStepLabel("scope-select", "local")).toBe("Step 6 of 7");
	});

	it("returns correct step label for local mode review (step 7)", () => {
		expect(getStepLabel("review", "local")).toBe("Step 7 of 7");
	});

	it("returns correct step label for full-cloud cloud-warning (TEST-27)", () => {
		// full-cloud list: cloud-warning is index 1 → Step 2 of 6
		expect(getStepLabel("cloud-warning", "full-cloud")).toBe("Step 2 of 6");
	});

	it("returns empty string for step not in mode's list (TEST-28)", () => {
		// hardware-detect is not in the full-cloud list
		expect(getStepLabel("hardware-detect", "full-cloud")).toBe("");
	});

	it("returns empty string for cloud-warning in local mode (not in local list)", () => {
		expect(getStepLabel("cloud-warning", "local")).toBe("");
	});

	it("returns correct step label for final review step in shared mode (TEST-29)", () => {
		// shared list: review is index 6 (last) → Step 7 of 7
		expect(getStepLabel("review", "shared")).toBe("Step 7 of 7");
	});

	it("returns correct step label for shared mode mode-select (step 1)", () => {
		expect(getStepLabel("mode-select", "shared")).toBe("Step 1 of 7");
	});

	it("returns correct step label for shared mode cloud-setup (step 2)", () => {
		// shared list: cloud-setup is index 1 → Step 2 of 7
		expect(getStepLabel("cloud-setup", "shared")).toBe("Step 2 of 7");
	});

	it("returns correct step label for full-cloud mode review (step 6)", () => {
		expect(getStepLabel("review", "full-cloud")).toBe("Step 6 of 6");
	});

	it("step number is always 1-indexed (not 0-indexed)", () => {
		// mode-select is always the first step and should show "Step 1", not "Step 0"
		const label = getStepLabel("mode-select", "local");
		expect(label.startsWith("Step 1")).toBe(true);
	});
});

// ============================================================================
// DEFAULT_WIZARD_STATE — initial values contract
// ============================================================================

describe("DEFAULT_WIZARD_STATE", () => {
	it("has all required WizardState fields (TEST-30)", () => {
		const state = DEFAULT_WIZARD_STATE;

		// Required fields per architecture §3.1
		expect(state).toHaveProperty("mode");
		expect(state).toHaveProperty("hardware");
		expect(state).toHaveProperty("provider");
		expect(state).toHaveProperty("ollamaEndpoint");
		expect(state).toHaveProperty("lmstudioEndpoint");
		expect(state).toHaveProperty("localEndpoint");
		expect(state).toHaveProperty("model");
		expect(state).toHaveProperty("pullProgress");
		expect(state).toHaveProperty("pullComplete");
		expect(state).toHaveProperty("cloudEndpoint");
		expect(state).toHaveProperty("cloudApiKey");
		expect(state).toHaveProperty("orgSlug");
		expect(state).toHaveProperty("repoSlug");
		expect(state).toHaveProperty("llm");
		expect(state).toHaveProperty("llmApiKey");
		expect(state).toHaveProperty("enrichmentSkipped");
		expect(state).toHaveProperty("llmEndpoint");
		expect(state).toHaveProperty("scope");
		expect(state).toHaveProperty("mergeExisting");
		expect(state).toHaveProperty("projectConfigExists");
		expect(state).toHaveProperty("runIndexAfterSave");
	});

	it("mode is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.mode).toBeNull();
	});

	it("hardware is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.hardware).toBeNull();
	});

	it("provider is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.provider).toBeNull();
	});

	it("ollamaEndpoint defaults to http://localhost:11434 (FR-9)", () => {
		expect(DEFAULT_WIZARD_STATE.ollamaEndpoint).toBe("http://localhost:11434");
	});

	it("lmstudioEndpoint defaults to http://localhost:1234/v1 (FR-9)", () => {
		expect(DEFAULT_WIZARD_STATE.lmstudioEndpoint).toBe(
			"http://localhost:1234/v1",
		);
	});

	it("localEndpoint defaults to empty string", () => {
		expect(DEFAULT_WIZARD_STATE.localEndpoint).toBe("");
	});

	it("model defaults to empty string", () => {
		expect(DEFAULT_WIZARD_STATE.model).toBe("");
	});

	it("pullProgress is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.pullProgress).toBeNull();
	});

	it("pullComplete is false initially", () => {
		expect(DEFAULT_WIZARD_STATE.pullComplete).toBe(false);
	});

	it("cloudEndpoint defaults to https://mem.madappgang.com (A-5)", () => {
		expect(DEFAULT_WIZARD_STATE.cloudEndpoint).toBe(
			"https://mem.madappgang.com",
		);
	});

	it("cloudApiKey is empty string initially", () => {
		expect(DEFAULT_WIZARD_STATE.cloudApiKey).toBe("");
	});

	it("orgSlug is empty string initially", () => {
		expect(DEFAULT_WIZARD_STATE.orgSlug).toBe("");
	});

	it("repoSlug is empty string initially", () => {
		expect(DEFAULT_WIZARD_STATE.repoSlug).toBe("");
	});

	it("llm defaults to cc/sonnet (default enrichment provider)", () => {
		expect(DEFAULT_WIZARD_STATE.llm).toBe("cc/sonnet");
	});

	it("llmApiKey is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.llmApiKey).toBeNull();
	});

	it("enrichmentSkipped is false initially", () => {
		expect(DEFAULT_WIZARD_STATE.enrichmentSkipped).toBe(false);
	});

	it("llmEndpoint is null initially", () => {
		expect(DEFAULT_WIZARD_STATE.llmEndpoint).toBeNull();
	});

	it("scope defaults to global", () => {
		expect(DEFAULT_WIZARD_STATE.scope).toBe("global");
	});

	it("mergeExisting is true initially (preserve existing config by default)", () => {
		expect(DEFAULT_WIZARD_STATE.mergeExisting).toBe(true);
	});

	it("projectConfigExists is false initially", () => {
		expect(DEFAULT_WIZARD_STATE.projectConfigExists).toBe(false);
	});

	it("runIndexAfterSave is null initially (not yet decided)", () => {
		expect(DEFAULT_WIZARD_STATE.runIndexAfterSave).toBeNull();
	});
});

// ============================================================================
// Type union validation — WizardStep values
// ============================================================================

describe("WizardStep values", () => {
	const allValidSteps: WizardStep[] = [
		"mode-select",
		"hardware-detect",
		"provider-select",
		"model-select",
		"cloud-warning",
		"cloud-setup",
		"enrichment-setup",
		"scope-select",
		"review",
		"saving",
		"done",
	];

	it("STEP_LISTS only contain valid WizardStep values", () => {
		const allStepsInLists = [
			...STEP_LISTS.local,
			...STEP_LISTS.shared,
			...STEP_LISTS["full-cloud"],
		];
		for (const step of allStepsInLists) {
			expect(allValidSteps).toContain(step);
		}
	});

	it("STEP_LISTS do not contain transient steps (saving, done)", () => {
		// Transient steps are not part of the user-facing wizard flow
		const transientSteps: WizardStep[] = ["saving", "done"];
		for (const mode of ["local", "shared", "full-cloud"] as DeploymentMode[]) {
			for (const step of transientSteps) {
				expect(STEP_LISTS[mode]).not.toContain(step);
			}
		}
	});
});

// ============================================================================
// ConfigScope values
// ============================================================================

describe("ConfigScope type", () => {
	it("DEFAULT_WIZARD_STATE.scope is a valid ConfigScope value", () => {
		const validScopes: ConfigScope[] = ["global", "project", "both"];
		expect(validScopes).toContain(DEFAULT_WIZARD_STATE.scope);
	});
});
