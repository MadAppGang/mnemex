/**
 * ContextEncoder - Encode task context for contextual bandits.
 *
 * Extracts relevant features from the current task state:
 * - File type being worked on
 * - Recent tool history
 * - Project type
 * - Time of day patterns
 *
 * These features help the bandit make context-aware decisions.
 */

// ============================================================================
// Types
// ============================================================================

export interface ContextEncoderConfig {
	/** Maximum history length to consider */
	maxHistoryLength: number;
	/** File type categories */
	fileTypeCategories: Record<string, string[]>;
	/** Project type detection patterns */
	projectPatterns: Record<string, string[]>;
	/** Whether to include time features */
	includeTimeFeatures: boolean;
}

export const DEFAULT_ENCODER_CONFIG: ContextEncoderConfig = {
	maxHistoryLength: 5,
	fileTypeCategories: {
		code: [".ts", ".js", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".rb"],
		test: [".test.ts", ".spec.ts", "_test.go", "_test.py", ".test.js"],
		config: [".json", ".yaml", ".yml", ".toml", ".env"],
		docs: [".md", ".txt", ".rst", ".adoc"],
		style: [".css", ".scss", ".less", ".styled.ts"],
	},
	projectPatterns: {
		typescript: ["tsconfig.json", "package.json"],
		python: ["pyproject.toml", "setup.py", "requirements.txt"],
		go: ["go.mod", "go.sum"],
		rust: ["Cargo.toml"],
	},
	includeTimeFeatures: true,
};

export interface TaskContext {
	/** Current file path (if any) */
	currentFile?: string;
	/** Recent tool history */
	recentTools: string[];
	/** Project root path */
	projectPath?: string;
	/** User's current goal/task description */
	taskDescription?: string;
	/** Any error messages */
	recentErrors?: string[];
	/** Custom context data */
	custom?: Record<string, string>;
}

export interface EncodedContext {
	/** Context feature strings */
	features: string[];
	/** Numeric feature vector (for ML) */
	vector: number[];
	/** Feature names for debugging */
	featureNames: string[];
	/** Context key for bandit lookup */
	contextKey: string;
}

export interface ContextFeature {
	name: string;
	value: string | number;
	category: "file" | "tool" | "project" | "time" | "error" | "custom";
}

// ============================================================================
// ContextEncoder Class
// ============================================================================

export class ContextEncoder {
	private config: ContextEncoderConfig;
	private projectTypeCache: Map<string, string>;

	constructor(config: Partial<ContextEncoderConfig> = {}) {
		this.config = { ...DEFAULT_ENCODER_CONFIG, ...config };
		this.projectTypeCache = new Map();
	}

	/**
	 * Encode task context into features.
	 */
	encode(context: TaskContext): EncodedContext {
		const features: ContextFeature[] = [];

		// File-based features
		if (context.currentFile) {
			features.push(...this.encodeFileFeatures(context.currentFile));
		}

		// Tool history features
		if (context.recentTools.length > 0) {
			features.push(...this.encodeToolFeatures(context.recentTools));
		}

		// Project features
		if (context.projectPath) {
			features.push(...this.encodeProjectFeatures(context.projectPath));
		}

		// Time features
		if (this.config.includeTimeFeatures) {
			features.push(...this.encodeTimeFeatures());
		}

		// Error features
		if (context.recentErrors && context.recentErrors.length > 0) {
			features.push(...this.encodeErrorFeatures(context.recentErrors));
		}

		// Custom features
		if (context.custom) {
			features.push(...this.encodeCustomFeatures(context.custom));
		}

		// Convert to strings and vector
		const featureStrings = features.map(
			(f) => `${f.category}:${f.name}=${f.value}`,
		);
		const featureNames = features.map((f) => `${f.category}:${f.name}`);
		const vector = this.featuresToVector(features);
		const contextKey = this.createContextKey(featureStrings);

		return {
			features: featureStrings,
			vector,
			featureNames,
			contextKey,
		};
	}

	/**
	 * Encode just file features (quick path).
	 */
	encodeFile(filePath: string): string[] {
		return this.encodeFileFeatures(filePath).map(
			(f) => `${f.category}:${f.name}=${f.value}`,
		);
	}

	/**
	 * Encode just tool history (quick path).
	 */
	encodeToolHistory(tools: string[]): string[] {
		return this.encodeToolFeatures(tools).map(
			(f) => `${f.category}:${f.name}=${f.value}`,
		);
	}

	/**
	 * Get context key for bandit lookup.
	 */
	getContextKey(context: TaskContext): string {
		return this.encode(context).contextKey;
	}

	/**
	 * Get most relevant features (for compact representation).
	 */
	getTopFeatures(context: TaskContext, n: number = 3): string[] {
		const encoded = this.encode(context);

		// Prioritize: file type > project type > recent tools
		const priority = ["file:type", "project:type", "tool:last"];
		const sorted = encoded.features.sort((a, b) => {
			const aIndex = priority.findIndex((p) => a.startsWith(p));
			const bIndex = priority.findIndex((p) => b.startsWith(p));
			return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
		});

		return sorted.slice(0, n);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Encode file-based features.
	 */
	private encodeFileFeatures(filePath: string): ContextFeature[] {
		const features: ContextFeature[] = [];

		// File extension
		const ext = this.getFileExtension(filePath);
		if (ext) {
			features.push({
				name: "extension",
				value: ext,
				category: "file",
			});
		}

		// File type category
		const fileType = this.categorizeFileType(filePath);
		features.push({
			name: "type",
			value: fileType,
			category: "file",
		});

		// Is test file?
		const isTest = this.isTestFile(filePath);
		features.push({
			name: "isTest",
			value: isTest ? "true" : "false",
			category: "file",
		});

		// Path depth (indicates complexity)
		const depth = filePath.split("/").length;
		features.push({
			name: "depth",
			value: Math.min(depth, 5), // Cap at 5
			category: "file",
		});

		return features;
	}

	/**
	 * Encode tool history features.
	 */
	private encodeToolFeatures(tools: string[]): ContextFeature[] {
		const features: ContextFeature[] = [];
		const recentTools = tools.slice(-this.config.maxHistoryLength);

		// Last tool
		if (recentTools.length > 0) {
			features.push({
				name: "last",
				value: recentTools[recentTools.length - 1],
				category: "tool",
			});
		}

		// Tool sequence pattern (simplified)
		if (recentTools.length >= 2) {
			const pattern = recentTools.slice(-2).join("->");
			features.push({
				name: "pattern2",
				value: pattern,
				category: "tool",
			});
		}

		if (recentTools.length >= 3) {
			const pattern = recentTools.slice(-3).join("->");
			features.push({
				name: "pattern3",
				value: pattern,
				category: "tool",
			});
		}

		// Tool frequency in recent history
		const toolCounts = new Map<string, number>();
		for (const tool of recentTools) {
			toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
		}

		// Most common recent tool
		const [mostCommon] = [...toolCounts.entries()].sort(
			(a, b) => b[1] - a[1],
		)[0] ?? ["none", 0];
		features.push({
			name: "frequent",
			value: mostCommon,
			category: "tool",
		});

		return features;
	}

	/**
	 * Encode project features.
	 */
	private encodeProjectFeatures(projectPath: string): ContextFeature[] {
		const features: ContextFeature[] = [];

		// Cached project type
		let projectType = this.projectTypeCache.get(projectPath);
		if (!projectType) {
			projectType = this.detectProjectType(projectPath);
			this.projectTypeCache.set(projectPath, projectType);
		}

		features.push({
			name: "type",
			value: projectType,
			category: "project",
		});

		return features;
	}

	/**
	 * Encode time features.
	 */
	private encodeTimeFeatures(): ContextFeature[] {
		const features: ContextFeature[] = [];
		const now = new Date();

		// Hour bucket (morning/afternoon/evening/night)
		const hour = now.getHours();
		let timeBucket: string;
		if (hour >= 6 && hour < 12) {
			timeBucket = "morning";
		} else if (hour >= 12 && hour < 17) {
			timeBucket = "afternoon";
		} else if (hour >= 17 && hour < 21) {
			timeBucket = "evening";
		} else {
			timeBucket = "night";
		}

		features.push({
			name: "bucket",
			value: timeBucket,
			category: "time",
		});

		// Day type (weekday/weekend)
		const day = now.getDay();
		const dayType = day === 0 || day === 6 ? "weekend" : "weekday";
		features.push({
			name: "dayType",
			value: dayType,
			category: "time",
		});

		return features;
	}

	/**
	 * Encode error features.
	 */
	private encodeErrorFeatures(errors: string[]): ContextFeature[] {
		const features: ContextFeature[] = [];

		// Has errors
		features.push({
			name: "hasErrors",
			value: "true",
			category: "error",
		});

		// Error count
		features.push({
			name: "count",
			value: Math.min(errors.length, 5),
			category: "error",
		});

		// Error type (simple classification)
		const recentError = errors[errors.length - 1];
		const errorType = this.classifyError(recentError);
		features.push({
			name: "type",
			value: errorType,
			category: "error",
		});

		return features;
	}

	/**
	 * Encode custom features.
	 */
	private encodeCustomFeatures(
		custom: Record<string, string>,
	): ContextFeature[] {
		return Object.entries(custom).map(([name, value]) => ({
			name,
			value,
			category: "custom" as const,
		}));
	}

	/**
	 * Convert features to numeric vector.
	 */
	private featuresToVector(features: ContextFeature[]): number[] {
		// Simple one-hot style encoding
		// In production, would use more sophisticated embedding
		const vector: number[] = [];

		for (const feature of features) {
			if (typeof feature.value === "number") {
				vector.push(feature.value);
			} else {
				// Hash string to number
				vector.push(this.hashString(feature.value) / 1000000);
			}
		}

		// Pad to fixed length
		while (vector.length < 20) {
			vector.push(0);
		}

		return vector.slice(0, 20);
	}

	/**
	 * Create context key from features.
	 */
	private createContextKey(features: string[]): string {
		// Use top features for key
		const topFeatures = features
			.filter(
				(f) =>
					f.startsWith("file:type") ||
					f.startsWith("project:type") ||
					f.startsWith("tool:last"),
			)
			.slice(0, 3);

		return topFeatures.join("||") || "default";
	}

	/**
	 * Get file extension.
	 */
	private getFileExtension(filePath: string): string {
		const parts = filePath.split(".");
		if (parts.length < 2) return "";

		// Handle compound extensions like .test.ts
		if (parts.length >= 3) {
			const last2 = `.${parts.slice(-2).join(".")}`;
			if (
				this.config.fileTypeCategories.test?.some((ext) => last2.endsWith(ext))
			) {
				return last2;
			}
		}

		return `.${parts[parts.length - 1]}`;
	}

	/**
	 * Categorize file type.
	 */
	private categorizeFileType(filePath: string): string {
		const ext = this.getFileExtension(filePath);

		for (const [category, extensions] of Object.entries(
			this.config.fileTypeCategories,
		)) {
			if (extensions.some((e) => ext.endsWith(e) || filePath.endsWith(e))) {
				return category;
			}
		}

		return "other";
	}

	/**
	 * Check if file is a test file.
	 */
	private isTestFile(filePath: string): boolean {
		const testPatterns = this.config.fileTypeCategories.test ?? [];
		return testPatterns.some(
			(pattern) =>
				filePath.includes(pattern) ||
				filePath.includes("__tests__") ||
				filePath.includes("/test/"),
		);
	}

	/**
	 * Detect project type from path.
	 */
	private detectProjectType(projectPath: string): string {
		// Simple heuristic based on common files
		// In production, would actually check file system
		const pathLower = projectPath.toLowerCase();

		if (pathLower.includes("typescript") || pathLower.includes("ts")) {
			return "typescript";
		}
		if (pathLower.includes("python") || pathLower.includes("py")) {
			return "python";
		}
		if (pathLower.includes("go")) {
			return "go";
		}
		if (pathLower.includes("rust") || pathLower.includes("cargo")) {
			return "rust";
		}

		return "unknown";
	}

	/**
	 * Classify error type.
	 */
	private classifyError(error: string): string {
		const errorLower = error.toLowerCase();

		if (errorLower.includes("timeout")) return "timeout";
		if (errorLower.includes("permission") || errorLower.includes("denied"))
			return "permission";
		if (errorLower.includes("not found") || errorLower.includes("missing"))
			return "not_found";
		if (
			errorLower.includes("syntax") ||
			errorLower.includes("parse") ||
			errorLower.includes("unexpected")
		)
			return "syntax";
		if (errorLower.includes("type") || errorLower.includes("typescript"))
			return "type";

		return "other";
	}

	/**
	 * Simple string hash.
	 */
	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a context encoder with optional configuration.
 */
export function createContextEncoder(
	config: Partial<ContextEncoderConfig> = {},
): ContextEncoder {
	return new ContextEncoder(config);
}
