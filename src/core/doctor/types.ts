/**
 * Doctor diagnostic types
 *
 * Type definitions for context file health analysis
 */

export type ContextFileType =
	| "claude-md"
	| "agents-md"
	| "cursorrules"
	| "copilot"
	| "skill"
	| "other";

export interface ContextFile {
	path: string;
	relativePath: string;
	type: ContextFileType;
	content: string;
	lineCount: number;
	tokenEstimate: number; // ~4 chars per token approximation
}

export interface CriterionResult {
	name: string;
	score: number; // 0-100
	weight: number;
	severity: "good" | "warning" | "critical";
	issues: string[];
	recommendations: string[];
}

export interface ContextFileDiagnosis {
	file: ContextFile;
	overallScore: number;
	criteria: CriterionResult[];
	costOverhead: { tokensPerQuery: number; budgetPercent: number };
}

export interface DoctorResult {
	projectPath: string;
	timestamp: string;
	filesFound: ContextFile[];
	diagnoses: ContextFileDiagnosis[];
	overallHealth: number; // 0-100
	topRecommendations: string[];
	researchCitations: string[];
}

export interface GeneratorAnswers {
	nonDiscoverable: string[]; // Things agents can't find in code
	gotchas: string[]; // Framework/tool pitfalls
	buildCommands: string[]; // Non-obvious commands
	neverDo: string[]; // Critical constraints
}

export interface GeneratedContext {
	claudeMd: string; // Optimized CLAUDE.md content (<50 lines)
	compactSkill: string; // Token-budgeted variant
	originalScore: number; // Score before
	newScore: number; // Score after
	linesSaved: number; // Lines reduced
}
