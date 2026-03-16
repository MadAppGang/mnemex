/**
 * Black Box Tests: Hardware Detection — hardware.ts
 *
 * Tests are based exclusively on requirements (requirements.md) and
 * the public API contract (architecture.md §4 + types.ts).
 *
 * Requirements tested:
 *   FR-4: Hardware profile detection (RAM, CPU, GPU)
 *   FR-5: Model suggestion tiers based on hardware
 *   FR-9: Default endpoint values
 *   NFR-11: Cross-platform graceful degradation
 *   Architecture §4.3: suggestModel() and suggestAlternateModel()
 */

import { describe, it, expect } from "bun:test";
import {
	detectHardware,
	suggestModel,
	suggestAlternateModel,
	type HardwareProfile,
} from "../../src/tui/setup/hardware.js";

// ============================================================================
// Helpers — construct minimal HardwareProfile for unit testing suggestModel
// ============================================================================

function makeProfile(
	totalRamGb: number,
	gpuType: HardwareProfile["gpuType"],
): HardwareProfile {
	return {
		totalRamGb,
		cpuModel: "Test CPU",
		cpuCores: 8,
		gpuType,
		ollamaReachable: false,
		ollamaEndpoint: "http://localhost:11434",
		ollamaModels: [],
		lmstudioReachable: false,
		lmstudioEndpoint: "http://localhost:1234/v1",
	};
}

// ============================================================================
// detectHardware() — live integration test
// ============================================================================

describe("detectHardware()", () => {
	it("returns a valid HardwareProfile with all required fields (TEST-1)", async () => {
		const profile = await detectHardware();

		// All required fields must be present
		expect(profile).toHaveProperty("totalRamGb");
		expect(profile).toHaveProperty("cpuModel");
		expect(profile).toHaveProperty("cpuCores");
		expect(profile).toHaveProperty("gpuType");
		expect(profile).toHaveProperty("ollamaReachable");
		expect(profile).toHaveProperty("ollamaEndpoint");
		expect(profile).toHaveProperty("ollamaModels");
		expect(profile).toHaveProperty("lmstudioReachable");
		expect(profile).toHaveProperty("lmstudioEndpoint");
	});

	it("totalRamGb is a positive number (TEST-2)", async () => {
		const profile = await detectHardware();
		expect(typeof profile.totalRamGb).toBe("number");
		expect(profile.totalRamGb).toBeGreaterThan(0);
	});

	it("cpuCores is a positive integer >= 1 (TEST-3)", async () => {
		const profile = await detectHardware();
		expect(typeof profile.cpuCores).toBe("number");
		expect(profile.cpuCores).toBeGreaterThanOrEqual(1);
		expect(Number.isInteger(profile.cpuCores)).toBe(true);
	});

	it("cpuModel is a non-empty string (TEST-4)", async () => {
		const profile = await detectHardware();
		expect(typeof profile.cpuModel).toBe("string");
		expect(profile.cpuModel.length).toBeGreaterThan(0);
	});

	it("gpuType is one of the valid enum values (TEST-5)", async () => {
		const profile = await detectHardware();
		const validGpuTypes = ["apple-silicon", "nvidia", "amd", "none", "unknown"];
		expect(validGpuTypes).toContain(profile.gpuType);
	});

	it("ollamaModels is an array (TEST-6)", async () => {
		const profile = await detectHardware();
		expect(Array.isArray(profile.ollamaModels)).toBe(true);
	});

	it("ollamaEndpoint matches expected default (TEST-7)", async () => {
		const profile = await detectHardware();
		expect(profile.ollamaEndpoint).toBe("http://localhost:11434");
	});

	it("lmstudioEndpoint matches expected default (TEST-8)", async () => {
		const profile = await detectHardware();
		expect(profile.lmstudioEndpoint).toBe("http://localhost:1234/v1");
	});

	it("ollamaReachable is a boolean (type safety check)", async () => {
		const profile = await detectHardware();
		expect(typeof profile.ollamaReachable).toBe("boolean");
	});

	it("lmstudioReachable is a boolean (type safety check)", async () => {
		const profile = await detectHardware();
		expect(typeof profile.lmstudioReachable).toBe("boolean");
	});

	it("ollamaModels is empty array when ollamaReachable is false", async () => {
		const profile = await detectHardware();
		// If Ollama is not reachable, models list must be empty
		// (FR-7: Ollama models only available when reachable)
		if (!profile.ollamaReachable) {
			expect(profile.ollamaModels).toEqual([]);
		}
	});

	it("gpuModel is a string when present (optional field)", async () => {
		const profile = await detectHardware();
		if (profile.gpuModel !== undefined) {
			expect(typeof profile.gpuModel).toBe("string");
			expect(profile.gpuModel.length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// suggestModel() — unit tests (pure function, no I/O)
// ============================================================================

describe("suggestModel()", () => {
	// Tier 1: >= 16 GB RAM + Apple Silicon or NVIDIA GPU → nomic-embed-text

	it("returns nomic-embed-text for 32 GB Apple Silicon (TEST-9)", () => {
		const hw = makeProfile(32, "apple-silicon");
		expect(suggestModel(hw)).toBe("nomic-embed-text");
	});

	it("returns nomic-embed-text for 32 GB NVIDIA GPU (TEST-10)", () => {
		const hw = makeProfile(32, "nvidia");
		expect(suggestModel(hw)).toBe("nomic-embed-text");
	});

	it("returns nomic-embed-text for exactly 16 GB Apple Silicon (tier 1 boundary) (TEST-11)", () => {
		const hw = makeProfile(16, "apple-silicon");
		expect(suggestModel(hw)).toBe("nomic-embed-text");
	});

	it("returns nomic-embed-text for exactly 16 GB NVIDIA GPU (tier 1 boundary)", () => {
		const hw = makeProfile(16, "nvidia");
		expect(suggestModel(hw)).toBe("nomic-embed-text");
	});

	it("does NOT return nomic-embed-text for 15.9 GB Apple Silicon — falls to tier 2 (TEST-12)", () => {
		const hw = makeProfile(15.9, "apple-silicon");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	// Tier 2: >= 8 GB RAM (any GPU) → snowflake-arctic-embed

	it("returns snowflake-arctic-embed for 8 GB RAM no discrete GPU (TEST-13)", () => {
		const hw = makeProfile(8, "none");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	it("returns snowflake-arctic-embed for exactly 8 GB RAM unknown GPU (tier 2 boundary) (TEST-14)", () => {
		const hw = makeProfile(8, "unknown");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	it("returns snowflake-arctic-embed for 8 GB RAM with AMD GPU", () => {
		const hw = makeProfile(8, "amd");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	it("returns snowflake-arctic-embed for 12 GB RAM with no GPU", () => {
		const hw = makeProfile(12, "none");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	// Tier 3: < 8 GB RAM → all-minilm-l6-v2

	it("returns all-minilm-l6-v2 for 7.9 GB RAM (just below tier 2) (TEST-15)", () => {
		const hw = makeProfile(7.9, "none");
		expect(suggestModel(hw)).toBe("all-minilm-l6-v2");
	});

	it("returns all-minilm-l6-v2 for 4 GB RAM (TEST-16)", () => {
		const hw = makeProfile(4, "unknown");
		expect(suggestModel(hw)).toBe("all-minilm-l6-v2");
	});

	it("returns all-minilm-l6-v2 for 2 GB RAM", () => {
		const hw = makeProfile(2, "none");
		expect(suggestModel(hw)).toBe("all-minilm-l6-v2");
	});

	it("AMD GPU with 16 GB RAM falls to tier 2, not tier 1 (TEST-17)", () => {
		// Architecture §4.3: tier 1 condition is apple-silicon OR nvidia only
		// AMD is NOT in tier 1
		const hw = makeProfile(16, "amd");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});

	it("AMD GPU with 32 GB RAM falls to tier 2, not tier 1", () => {
		const hw = makeProfile(32, "amd");
		expect(suggestModel(hw)).toBe("snowflake-arctic-embed");
	});
});

// ============================================================================
// suggestAlternateModel() — unit tests
// ============================================================================

describe("suggestAlternateModel()", () => {
	it("returns bge-m3 for 32 GB Apple Silicon (TEST-18)", () => {
		const hw = makeProfile(32, "apple-silicon");
		expect(suggestAlternateModel(hw)).toBe("bge-m3");
	});

	it("returns bge-m3 for 32 GB NVIDIA GPU", () => {
		const hw = makeProfile(32, "nvidia");
		expect(suggestAlternateModel(hw)).toBe("bge-m3");
	});

	it("returns bge-m3 for exactly 16 GB Apple Silicon (tier 1 boundary)", () => {
		const hw = makeProfile(16, "apple-silicon");
		expect(suggestAlternateModel(hw)).toBe("bge-m3");
	});

	it("returns nomic-embed-text for 8–15 GB RAM (TEST-19)", () => {
		const hw = makeProfile(8, "none");
		expect(suggestAlternateModel(hw)).toBe("nomic-embed-text");
	});

	it("returns nomic-embed-text for 12 GB RAM unknown GPU", () => {
		const hw = makeProfile(12, "unknown");
		expect(suggestAlternateModel(hw)).toBe("nomic-embed-text");
	});

	it("returns null for 4 GB RAM (TEST-20)", () => {
		const hw = makeProfile(4, "unknown");
		expect(suggestAlternateModel(hw)).toBeNull();
	});

	it("returns null for 2 GB RAM", () => {
		const hw = makeProfile(2, "none");
		expect(suggestAlternateModel(hw)).toBeNull();
	});

	it("returns null for 7.9 GB RAM", () => {
		const hw = makeProfile(7.9, "none");
		expect(suggestAlternateModel(hw)).toBeNull();
	});
});
