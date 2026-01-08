/**
 * E2E Validation System
 *
 * Core infrastructure for testing continuous learning improvements
 * using synthetic agents and A/B experiments.
 *
 * @module learning/validation
 */

// ============================================================================
// Types
// ============================================================================

export type {
	// Scenario types
	ScenarioCategory,
	ScenarioDifficulty,
	ValidationScenario,
	// User persona types
	ExpertiseLevel,
	Verbosity,
	CorrectionStyle,
	UserPersona,
	// Knowledge base types
	ProgrammingLanguage,
	PackageManager,
	ComponentStyle,
	ScenarioKnowledgeBase,
	// Correction types
	CorrectionPoint,
	CorrectionTrigger,
	// Success criteria types
	SuccessCriterion,
	// Session types
	SessionOutcome,
	ExperimentGroup,
	RecordedSession,
	ToolEvent,
	RecordedCorrection,
	UserResponse,
	CriteriaResult,
	SessionMetrics,
	// Experiment types
	ExperimentStatus,
	ExperimentDecisionAction,
	ValidationExperiment,
	ExperimentResults,
	AggregateResults,
	ScenarioResults,
	// Statistical types
	StatisticalComparison,
	MetricComparison,
	ExperimentDecision,
	StatisticalConfig,
	PowerAnalysisConfig,
	// Validation tier types
	ValidationTier,
	TierConfig,
	// Execution types
	ExecutionTask,
	RunConfig,
	ExecutionStatus,
	ExecutionResult,
	// Agent response types
	AgentResponse,
	ToolCall,
	AgentError,
	TokenUsage,
	AgentConfig,
} from "./types.js";

export {
	DEFAULT_KNOWLEDGE_BASE,
	DEFAULT_STATISTICAL_CONFIG,
	VALIDATION_TIERS,
} from "./types.js";

// ============================================================================
// Agent Driver
// ============================================================================

export type {
	AgentDriver,
	ToolExecutionResult,
	DriverStats,
	LocalDriverConfig,
	HttpDriverConfig,
	MockResponse,
	DriverType,
	CreateDriverOptions,
} from "./agent-driver.js";

export {
	LocalAgentDriver,
	HttpAgentDriver,
	MockAgentDriver,
	createAgentDriver,
} from "./agent-driver.js";

// ============================================================================
// Session Recorder
// ============================================================================

export type {
	SessionRecorderOptions,
	SessionSnapshot,
} from "./session-recorder.js";

export {
	SessionRecorder,
	CriteriaEvaluator,
} from "./session-recorder.js";

// ============================================================================
// Validation Store
// ============================================================================

export type { SummaryStats } from "./validation-store.js";

export {
	ValidationStore,
	createValidationStore,
} from "./validation-store.js";

// ============================================================================
// Environment Manager
// ============================================================================

export type {
	EnvironmentManager,
	EnvironmentType,
	EnvironmentInfo,
	SnapshotInfo,
	EnvironmentConfig,
} from "./environment-manager.js";

export {
	TempEnvironmentManager,
	GitEnvironmentManager,
	DockerEnvironmentManager,
	MockEnvironmentManager,
	createEnvironmentManager,
	EnvironmentPool,
} from "./environment-manager.js";

// ============================================================================
// Scenario Library
// ============================================================================

export {
	ScenarioLibrary,
	ScenarioBuilder,
	createScenarioLibrary,
	scenario,
	PERSONAS,
	KNOWLEDGE_BASES,
} from "./scenario-library.js";

// ============================================================================
// Synthetic Agent
// ============================================================================

export type {
	QueryAnswer,
	CorrectionResult,
	SyntheticResponse,
} from "./synthetic-agent.js";

export {
	SyntheticAgent,
	QueryHandler,
	CorrectionInjector,
	createSyntheticAgent,
} from "./synthetic-agent.js";

// ============================================================================
// Statistics Engine
// ============================================================================

export type { EffectSizeInterpretation } from "./statistics-engine.js";

export {
	StatisticsEngine,
	createStatisticsEngine,
} from "./statistics-engine.js";

// ============================================================================
// Experiment Engine
// ============================================================================

export type {
	ExperimentEngineOptions,
	ExperimentConfig,
	ExecutorConfig,
	DriverFactory,
} from "./experiment-engine.js";

export {
	ExperimentEngine,
	ParallelExecutor,
	DecisionEngine,
	createExperimentEngine,
} from "./experiment-engine.js";
