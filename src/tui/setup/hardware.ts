/**
 * Hardware Detection for Setup Wizard
 *
 * Pure functions — no React dependencies.
 * Detects RAM, CPU, GPU type, and checks for running local embedding servers.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";

// ============================================================================
// Types
// ============================================================================

export interface HardwareProfile {
	totalRamGb: number;
	cpuModel: string;
	cpuCores: number;
	gpuType: "apple-silicon" | "nvidia" | "amd" | "none" | "unknown";
	gpuModel?: string;
	ollamaReachable: boolean;
	ollamaEndpoint: string;
	ollamaModels: string[];
	lmstudioReachable: boolean;
	lmstudioEndpoint: string;
}

// ============================================================================
// Hardware Detection
// ============================================================================

/**
 * Detect system hardware profile including GPU, RAM, CPU, and running servers.
 */
export async function detectHardware(): Promise<HardwareProfile> {
	const totalRamGb = os.totalmem() / (1024 * 1024 * 1024);
	const cpus = os.cpus();
	const cpuModel = cpus[0]?.model ?? "Unknown CPU";
	const cpuCores = cpus.length;

	// Detect GPU type
	const { gpuType, gpuModel } = detectGpu();

	// Check for running servers in parallel
	const ollamaEndpoint = "http://localhost:11434";
	const lmstudioEndpoint = "http://localhost:1234/v1";

	const [ollamaResult, lmstudioResult] = await Promise.allSettled([
		checkOllama(ollamaEndpoint),
		checkLmStudio(lmstudioEndpoint),
	]);

	const ollamaData =
		ollamaResult.status === "fulfilled" ? ollamaResult.value : null;
	const lmstudioReachable =
		lmstudioResult.status === "fulfilled" ? lmstudioResult.value : false;

	return {
		totalRamGb,
		cpuModel,
		cpuCores,
		gpuType,
		gpuModel,
		ollamaReachable: ollamaData !== null,
		ollamaEndpoint,
		ollamaModels: ollamaData?.models ?? [],
		lmstudioReachable,
		lmstudioEndpoint,
	};
}

// ============================================================================
// GPU Detection
// ============================================================================

function detectGpu(): {
	gpuType: HardwareProfile["gpuType"];
	gpuModel?: string;
} {
	const platform = os.platform();

	try {
		if (platform === "darwin") {
			return detectAppleGpu();
		}
		if (platform === "linux" || platform === "win32") {
			return detectLinuxOrWindowsGpu();
		}
	} catch {
		// Graceful fallback
	}

	return { gpuType: "unknown" };
}

function detectAppleGpu(): {
	gpuType: HardwareProfile["gpuType"];
	gpuModel?: string;
} {
	try {
		const result = spawnSync(
			"system_profiler",
			["SPHardwareDataType", "-json"],
			{ encoding: "utf8", timeout: 3000 },
		);

		if (result.error || result.status !== 0) {
			return { gpuType: "unknown" };
		}

		const data = JSON.parse(result.stdout) as {
			SPHardwareDataType?: Array<{ chip_type?: string; machine_name?: string }>;
		};
		const hwData = data.SPHardwareDataType?.[0];
		const chipType = hwData?.chip_type ?? "";
		const machineName = hwData?.machine_name ?? "";

		// Apple Silicon: M1, M2, M3, M4 chips
		if (
			chipType.toLowerCase().includes("apple m") ||
			machineName.toLowerCase().includes("mac")
		) {
			const chipMatch = chipType.match(/(Apple M\d+(?:\s+\w+)?)/i);
			return {
				gpuType: "apple-silicon",
				gpuModel: chipMatch?.[1] ?? (chipType || "Apple Silicon"),
			};
		}

		return { gpuType: "none" };
	} catch {
		return { gpuType: "unknown" };
	}
}

function detectLinuxOrWindowsGpu(): {
	gpuType: HardwareProfile["gpuType"];
	gpuModel?: string;
} {
	// Try nvidia-smi first
	try {
		const nvidiaResult = spawnSync(
			"nvidia-smi",
			["--query-gpu=name", "--format=csv,noheader"],
			{ encoding: "utf8", timeout: 3000 },
		);

		if (nvidiaResult.status === 0 && nvidiaResult.stdout.trim()) {
			return {
				gpuType: "nvidia",
				gpuModel: nvidiaResult.stdout.trim().split("\n")[0]?.trim(),
			};
		}
	} catch {
		// no nvidia-smi
	}

	// Try rocm-smi for AMD
	try {
		const amdResult = spawnSync("rocm-smi", ["--showproductname"], {
			encoding: "utf8",
			timeout: 3000,
		});

		if (amdResult.status === 0 && amdResult.stdout.trim()) {
			const lines = amdResult.stdout.trim().split("\n");
			const gpuLine = lines.find((l) => l.toLowerCase().includes("gpu"));
			return {
				gpuType: "amd",
				gpuModel: gpuLine?.trim() ?? "AMD GPU",
			};
		}
	} catch {
		// no rocm-smi
	}

	return { gpuType: "none" };
}

// ============================================================================
// Server Detection
// ============================================================================

interface OllamaData {
	models: string[];
}

async function checkOllama(endpoint: string): Promise<OllamaData | null> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(`${endpoint}/api/tags`, {
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as {
			models?: Array<{ name: string }>;
		};
		const models = (data.models ?? []).map((m) => m.name);
		return { models };
	} catch {
		return null;
	}
}

async function checkLmStudio(endpoint: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(`${endpoint}/models`, {
			signal: controller.signal,
		});
		clearTimeout(timeoutId);

		return response.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Model Recommendations
// ============================================================================

/**
 * Suggest a primary embedding model based on hardware profile.
 * Tier 1 (>=16GB + Apple Silicon or NVIDIA): nomic-embed-text (best quality)
 * Tier 2 (>=8GB): snowflake-arctic-embed (good balance)
 * Tier 3 (<8GB): all-minilm-l6-v2 (small, fast)
 */
export function suggestModel(hw: HardwareProfile): string {
	const hasGoodGpu = hw.gpuType === "apple-silicon" || hw.gpuType === "nvidia";

	if (hw.totalRamGb >= 16 && hasGoodGpu) {
		return "nomic-embed-text";
	}
	if (hw.totalRamGb >= 8) {
		return "snowflake-arctic-embed";
	}
	return "all-minilm-l6-v2";
}

/**
 * Suggest an alternate embedding model (second recommendation for display).
 * Returns null for very low-memory machines.
 */
export function suggestAlternateModel(hw: HardwareProfile): string | null {
	if (hw.totalRamGb < 8) {
		return null;
	}
	const primary = suggestModel(hw);
	if (primary === "nomic-embed-text") {
		return "bge-m3";
	}
	return "nomic-embed-text";
}
