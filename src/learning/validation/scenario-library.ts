/**
 * Scenario Library
 *
 * Predefined validation scenarios for testing agent behavior.
 * Each scenario defines setup, expected behavior, and success criteria.
 *
 * @module learning/validation/scenario-library
 */

import type {
  ValidationScenario,
  ScenarioCategory,
  ScenarioDifficulty,
  UserPersona,
  ScenarioKnowledgeBase,
  CorrectionPoint,
  SuccessCriterion,
} from "./types.js";

// ============================================================================
// Scenario Library
// ============================================================================

/**
 * Manages the collection of validation scenarios.
 */
export class ScenarioLibrary {
  private scenarios: Map<string, ValidationScenario> = new Map();

  constructor() {
    this.registerBuiltInScenarios();
  }

  /**
   * Get a scenario by ID
   */
  get(id: string): ValidationScenario | undefined {
    return this.scenarios.get(id);
  }

  /**
   * Get all scenarios
   */
  getAll(): ValidationScenario[] {
    return Array.from(this.scenarios.values());
  }

  /**
   * Get scenarios by category
   */
  getByCategory(category: ScenarioCategory): ValidationScenario[] {
    return this.getAll().filter((s) => s.category === category);
  }

  /**
   * Get scenarios by difficulty
   */
  getByDifficulty(difficulty: ScenarioDifficulty): ValidationScenario[] {
    return this.getAll().filter((s) => s.difficulty === difficulty);
  }

  /**
   * Get scenarios by IDs
   */
  getByIds(ids: string[]): ValidationScenario[] {
    return ids
      .map((id) => this.scenarios.get(id))
      .filter((s): s is ValidationScenario => s !== undefined);
  }

  /**
   * Register a custom scenario
   */
  register(scenario: ValidationScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  /**
   * Get scenario count
   */
  count(): number {
    return this.scenarios.size;
  }

  /**
   * Get scenario IDs
   */
  getIds(): string[] {
    return Array.from(this.scenarios.keys());
  }

  // ============================================================================
  // Built-in Scenarios
  // ============================================================================

  private registerBuiltInScenarios(): void {
    // Register all predefined scenarios
    BUILT_IN_SCENARIOS.forEach((scenario) => {
      this.scenarios.set(scenario.id, scenario);
    });
  }
}

// ============================================================================
// Default Personas
// ============================================================================

export const PERSONAS: Record<string, UserPersona> = {
  novice: {
    expertiseLevel: "novice",
    verbosity: "verbose",
    correctionStyle: "polite",
    patience: 0.8,
  },
  intermediate: {
    expertiseLevel: "intermediate",
    verbosity: "normal",
    correctionStyle: "direct",
    patience: 0.6,
  },
  expert: {
    expertiseLevel: "expert",
    verbosity: "terse",
    correctionStyle: "direct",
    patience: 0.4,
  },
  impatient: {
    expertiseLevel: "intermediate",
    verbosity: "terse",
    correctionStyle: "frustrated",
    patience: 0.3,
  },
};

// ============================================================================
// Default Knowledge Bases
// ============================================================================

export const KNOWLEDGE_BASES: Record<string, ScenarioKnowledgeBase> = {
  typescript_react: {
    language: "typescript",
    packageManager: "npm",
    framework: "react",
    testFramework: "jest",
    styleGuide: "airbnb",
    componentStyle: "functional",
    stateManagement: "zustand",
    nodeVersion: "20",
    targetBrowser: ["chrome", "firefox", "safari"],
  },
  typescript_node: {
    language: "typescript",
    packageManager: "npm",
    framework: "express",
    testFramework: "jest",
    nodeVersion: "20",
  },
  python_fastapi: {
    language: "python",
    testFramework: "pytest",
    customAnswers: {
      "virtual environment": "venv",
      "python version": "3.11",
    },
  },
};

// ============================================================================
// Built-in Scenarios
// ============================================================================

const BUILT_IN_SCENARIOS: ValidationScenario[] = [
  // ============================================================================
  // #1: File Operations - Create Component
  // ============================================================================
  {
    id: "file-create-component",
    name: "Create React Component",
    description:
      "Create a new Button component with TypeScript, props interface, and basic styling",
    difficulty: 2,
    category: "file_operations",

    projectTemplate: "templates/react-typescript",
    initialPrompt:
      "Create a new Button component in src/components/Button.tsx with primary and secondary variants",

    persona: PERSONAS.intermediate,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_react,
      customAnswers: {
        "styling approach": "CSS modules",
        "button variants": "primary, secondary, and disabled states",
      },
    },

    expectedTools: ["Read", "Write", "Glob"],
    forbiddenTools: ["Bash"],
    maxToolCalls: 15,
    maxCorrections: 2,

    correctionPoints: [
      {
        trigger: { type: "file_not_found", pattern: "Button.tsx" },
        correction: "The file should be in src/components/Button.tsx",
        expectedRecovery: ["Write"],
      },
    ],

    successCriteria: [
      { type: "file_exists", path: "src/components/Button.tsx" },
      {
        type: "file_contains",
        path: "src/components/Button.tsx",
        pattern: "interface.*Props",
      },
      {
        type: "file_contains",
        path: "src/components/Button.tsx",
        pattern: "variant.*primary|secondary",
      },
      {
        type: "file_contains",
        path: "src/components/Button.tsx",
        pattern: "export.*Button",
      },
    ],
  },

  // ============================================================================
  // #2: Code Search - Find Authentication
  // ============================================================================
  {
    id: "code-search-auth",
    name: "Find Authentication Implementation",
    description:
      "Search the codebase to understand how authentication is implemented",
    difficulty: 2,
    category: "code_search",

    projectTemplate: "templates/express-auth",
    initialPrompt:
      "How is user authentication implemented in this codebase? I need to understand the flow.",

    persona: PERSONAS.novice,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_node,
      customAnswers: {
        "auth method": "JWT tokens",
        "session storage": "Redis",
      },
    },

    expectedTools: ["Grep", "Glob", "Read"],
    forbiddenTools: ["Write", "Edit"],
    maxToolCalls: 20,
    maxCorrections: 1,

    correctionPoints: [],

    successCriteria: [
      { type: "files_read", minCount: 3 },
      {
        type: "response_mentions",
        patterns: ["JWT", "token", "middleware", "authenticate"],
      },
      { type: "no_file_modifications" },
    ],
  },

  // ============================================================================
  // #3: Refactoring - Rename Function
  // ============================================================================
  {
    id: "refactor-rename-function",
    name: "Rename Function Across Codebase",
    description:
      "Rename getUserData to fetchUserProfile across all files that use it",
    difficulty: 3,
    category: "refactoring",

    projectTemplate: "templates/refactor-project",
    initialPrompt:
      "Rename the function getUserData to fetchUserProfile everywhere it's used",

    persona: PERSONAS.expert,
    knowledgeBase: KNOWLEDGE_BASES.typescript_node,

    expectedTools: ["Grep", "Read", "Edit"],
    maxToolCalls: 25,
    maxCorrections: 2,

    correctionPoints: [
      {
        trigger: { type: "tool_count", threshold: 10 },
        correction: "Make sure you've found ALL usages before making changes",
        expectedRecovery: ["Grep"],
      },
    ],

    successCriteria: [
      {
        type: "no_matches",
        pattern: "getUserData",
        excludePaths: ["*.test.ts", "*.spec.ts"],
      },
      { type: "file_contains", path: "src/services/user.ts", pattern: "fetchUserProfile" },
      { type: "tests_pass" },
    ],
  },

  // ============================================================================
  // #4: Debugging - Fix Async Bug
  // ============================================================================
  {
    id: "debug-async-bug",
    name: "Fix Async Race Condition",
    description:
      "Debug and fix a race condition in the data fetching logic",
    difficulty: 4,
    category: "debugging",

    projectTemplate: "templates/async-bug",
    initialPrompt:
      "Users are reporting that sometimes the dashboard shows stale data. Can you investigate and fix?",

    persona: PERSONAS.intermediate,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_react,
      customAnswers: {
        "reproduction steps": "Rapidly switch between tabs",
        "frequency": "About 1 in 5 times",
      },
    },

    expectedTools: ["Read", "Grep", "Edit"],
    maxToolCalls: 30,
    maxCorrections: 3,

    correctionPoints: [
      {
        trigger: { type: "wrong_tool", tool: "Write" },
        correction:
          "Please use Edit to modify existing files rather than rewriting them",
        expectedRecovery: ["Edit"],
      },
    ],

    successCriteria: [
      {
        type: "file_contains",
        path: "src/hooks/useDataFetch.ts",
        pattern: "AbortController|cancel|isMounted",
      },
      { type: "tests_pass" },
      { type: "no_errors" },
    ],
  },

  // ============================================================================
  // #5: Testing - Write Unit Tests
  // ============================================================================
  {
    id: "testing-write-unit-tests",
    name: "Write Unit Tests for Service",
    description:
      "Write comprehensive unit tests for the UserService class",
    difficulty: 3,
    category: "testing",

    projectTemplate: "templates/testing-project",
    initialPrompt:
      "Write unit tests for the UserService class in src/services/user.ts",

    persona: PERSONAS.intermediate,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_node,
      customAnswers: {
        "mock strategy": "Use jest.mock for external dependencies",
        "coverage target": "80% line coverage",
      },
    },

    expectedTools: ["Read", "Write", "Bash"],
    maxToolCalls: 20,
    maxCorrections: 2,

    correctionPoints: [
      {
        trigger: { type: "file_not_found", pattern: "user.test.ts" },
        correction:
          "Tests should be in src/services/__tests__/user.test.ts",
        expectedRecovery: ["Write"],
      },
    ],

    successCriteria: [
      { type: "file_exists", path: "src/services/__tests__/user.test.ts" },
      {
        type: "file_contains",
        path: "src/services/__tests__/user.test.ts",
        pattern: "describe.*UserService",
      },
      {
        type: "file_contains",
        path: "src/services/__tests__/user.test.ts",
        pattern: "expect.*toHaveBeenCalled|toBe|toEqual",
      },
      { type: "tests_pass" },
    ],
  },

  // ============================================================================
  // #6: Git Operations - Create Feature Branch
  // ============================================================================
  {
    id: "git-feature-branch",
    name: "Create Feature Branch with Changes",
    description:
      "Create a new feature branch, make changes, and prepare for PR",
    difficulty: 2,
    category: "git_operations",

    projectTemplate: "templates/git-project",
    initialPrompt:
      "Create a feature branch called 'add-user-preferences' and add a preferences field to the User model",

    persona: PERSONAS.intermediate,
    knowledgeBase: KNOWLEDGE_BASES.typescript_node,

    expectedTools: ["Bash", "Read", "Edit"],
    maxToolCalls: 15,
    maxCorrections: 2,

    correctionPoints: [
      {
        trigger: { type: "error", errorType: "git" },
        correction: "Make sure you're on a clean working tree before branching",
        expectedRecovery: ["Bash"],
      },
    ],

    successCriteria: [
      {
        type: "file_contains",
        path: "src/models/user.ts",
        pattern: "preferences",
      },
      { type: "no_errors", excludeTypes: ["git warning"] },
    ],
  },

  // ============================================================================
  // #7: Documentation - Add JSDoc
  // ============================================================================
  {
    id: "docs-add-jsdoc",
    name: "Add JSDoc Documentation",
    description:
      "Add comprehensive JSDoc comments to the API service module",
    difficulty: 2,
    category: "documentation",

    projectTemplate: "templates/docs-project",
    initialPrompt:
      "Add JSDoc documentation to all exported functions in src/services/api.ts",

    persona: PERSONAS.expert,
    knowledgeBase: KNOWLEDGE_BASES.typescript_node,

    expectedTools: ["Read", "Edit"],
    forbiddenTools: ["Bash"],
    maxToolCalls: 15,
    maxCorrections: 1,

    correctionPoints: [],

    successCriteria: [
      {
        type: "file_contains",
        path: "src/services/api.ts",
        pattern: "/\\*\\*[\\s\\S]*?@param",
      },
      {
        type: "file_contains",
        path: "src/services/api.ts",
        pattern: "@returns",
      },
      {
        type: "file_contains",
        path: "src/services/api.ts",
        pattern: "@throws|@example",
      },
    ],
  },

  // ============================================================================
  // #8: Multi-step - Add Feature End-to-End
  // ============================================================================
  {
    id: "multi-step-add-feature",
    name: "Add Complete Feature",
    description:
      "Add a user avatar feature: model update, API endpoint, and UI component",
    difficulty: 5,
    category: "multi_step",

    projectTemplate: "templates/fullstack-project",
    initialPrompt:
      "Add user avatar support: update the User model, create an upload endpoint, and add an Avatar component",

    persona: PERSONAS.intermediate,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_react,
      customAnswers: {
        "storage": "S3 bucket",
        "max file size": "5MB",
        "allowed formats": "jpg, png, webp",
      },
    },

    expectedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    maxToolCalls: 40,
    maxCorrections: 4,

    correctionPoints: [
      {
        trigger: { type: "tool_count", threshold: 20 },
        correction:
          "Let's focus on one part at a time. Start with the model changes.",
        expectedRecovery: ["Read", "Edit"],
      },
      {
        trigger: { type: "random", probability: 0.3 },
        correction:
          "The avatar should have a default placeholder image",
        expectedRecovery: ["Edit"],
      },
    ],

    successCriteria: [
      {
        type: "file_contains",
        path: "src/models/user.ts",
        pattern: "avatar",
      },
      { type: "file_exists", path: "src/api/avatar.ts" },
      { type: "file_exists", path: "src/components/Avatar.tsx" },
      { type: "tests_pass" },
    ],
  },

  // ============================================================================
  // #9: Error Recovery - Handle Bash Failure
  // ============================================================================
  {
    id: "error-recovery-bash",
    name: "Recover from Command Failure",
    description:
      "Handle npm install failure and find alternative solution",
    difficulty: 3,
    category: "error_recovery",

    projectTemplate: "templates/broken-deps",
    initialPrompt:
      "Install the project dependencies and start the development server",

    persona: PERSONAS.novice,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_node,
      customAnswers: {
        "alternative registry": "Use yarn if npm fails",
        "node version": "Requires Node 18+",
      },
    },

    expectedTools: ["Bash", "Read"],
    maxToolCalls: 20,
    maxCorrections: 3,

    correctionPoints: [
      {
        trigger: { type: "error", errorType: "npm ERR!" },
        correction:
          "npm seems to have issues. Try checking package.json for problems or use a different approach",
        expectedRecovery: ["Read", "Bash"],
      },
    ],

    successCriteria: [
      { type: "no_errors", excludeTypes: ["npm WARN"] },
    ],
  },

  // ============================================================================
  // #10: Ambiguous - Vague Feature Request
  // ============================================================================
  {
    id: "ambiguous-add-feature",
    name: "Handle Vague Request",
    description:
      "User asks to 'make the app better' - should ask clarifying questions",
    difficulty: 3,
    category: "ambiguous",

    projectTemplate: "templates/basic-app",
    initialPrompt: "Can you make the app better?",

    persona: PERSONAS.novice,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_react,
      customAnswers: {
        "what aspect": "Performance is slow",
        "specific page": "The dashboard takes too long to load",
        "acceptable load time": "Under 2 seconds",
      },
    },

    expectedTools: ["Read", "Grep"],
    forbiddenTools: ["Write", "Edit"],
    maxToolCalls: 10,
    maxCorrections: 0,

    correctionPoints: [],

    successCriteria: [
      { type: "asks_clarification" },
      { type: "no_file_modifications" },
    ],
  },

  // ============================================================================
  // #11: Security - Fix SQL Injection
  // ============================================================================
  {
    id: "security-sql-injection",
    name: "Fix SQL Injection Vulnerability",
    description:
      "Identify and fix SQL injection vulnerability in user search",
    difficulty: 4,
    category: "security",

    projectTemplate: "templates/vulnerable-app",
    initialPrompt:
      "Security audit flagged a SQL injection risk in the search feature. Please fix it.",

    persona: PERSONAS.expert,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_node,
      customAnswers: {
        "database": "PostgreSQL",
        "ORM": "Raw SQL queries, no ORM",
      },
    },

    expectedTools: ["Read", "Grep", "Edit"],
    maxToolCalls: 20,
    maxCorrections: 2,

    correctionPoints: [
      {
        trigger: { type: "file_contains", pattern: "\\$\\{.*\\}" },
        correction:
          "Template literals in SQL queries are dangerous. Use parameterized queries.",
        expectedRecovery: ["Edit"],
      },
    ],

    successCriteria: [
      {
        type: "file_not_contains",
        path: "src/api/search.ts",
        pattern: "\\`SELECT.*\\$\\{",
      },
      {
        type: "file_contains",
        path: "src/api/search.ts",
        pattern: "\\$1|\\?|:param|parameterized",
      },
      { type: "tests_pass" },
    ],
  },

  // ============================================================================
  // #12: Security - Secrets Detection
  // ============================================================================
  {
    id: "security-secrets-handling",
    name: "Fix Hardcoded Secrets",
    description:
      "Find and remove hardcoded secrets, implement proper env handling",
    difficulty: 3,
    category: "security",

    projectTemplate: "templates/secrets-exposed",
    initialPrompt:
      "There might be hardcoded API keys in the codebase. Find and fix them.",

    persona: PERSONAS.intermediate,
    knowledgeBase: {
      ...KNOWLEDGE_BASES.typescript_node,
      customAnswers: {
        "env management": "dotenv with .env.example",
        "secret storage": "Environment variables, never commit actual values",
      },
    },

    expectedTools: ["Grep", "Read", "Edit", "Write"],
    maxToolCalls: 25,
    maxCorrections: 2,

    correctionPoints: [],

    successCriteria: [
      {
        type: "no_matches",
        pattern: "sk-[a-zA-Z0-9]{32,}|AKIA[A-Z0-9]{16}",
        excludePaths: [".env.example", "*.md"],
      },
      { type: "file_exists", path: ".env.example" },
      {
        type: "file_contains",
        path: ".env.example",
        pattern: "API_KEY=",
      },
      {
        type: "file_contains",
        path: "src/config.ts",
        pattern: "process\\.env\\.",
      },
    ],
  },
];

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a scenario library with optional custom scenarios
 */
export function createScenarioLibrary(
  customScenarios?: ValidationScenario[]
): ScenarioLibrary {
  const library = new ScenarioLibrary();

  if (customScenarios) {
    customScenarios.forEach((scenario) => library.register(scenario));
  }

  return library;
}

// ============================================================================
// Scenario Builder
// ============================================================================

/**
 * Builder for creating custom validation scenarios
 */
export class ScenarioBuilder {
  private scenario: Partial<ValidationScenario> = {};

  id(id: string): this {
    this.scenario.id = id;
    return this;
  }

  name(name: string): this {
    this.scenario.name = name;
    return this;
  }

  description(description: string): this {
    this.scenario.description = description;
    return this;
  }

  difficulty(difficulty: ScenarioDifficulty): this {
    this.scenario.difficulty = difficulty;
    return this;
  }

  category(category: ScenarioCategory): this {
    this.scenario.category = category;
    return this;
  }

  template(templatePath: string): this {
    this.scenario.projectTemplate = templatePath;
    return this;
  }

  prompt(prompt: string): this {
    this.scenario.initialPrompt = prompt;
    return this;
  }

  persona(persona: UserPersona): this {
    this.scenario.persona = persona;
    return this;
  }

  knowledgeBase(kb: ScenarioKnowledgeBase): this {
    this.scenario.knowledgeBase = kb;
    return this;
  }

  expectedTools(tools: string[]): this {
    this.scenario.expectedTools = tools;
    return this;
  }

  forbiddenTools(tools: string[]): this {
    this.scenario.forbiddenTools = tools;
    return this;
  }

  maxToolCalls(max: number): this {
    this.scenario.maxToolCalls = max;
    return this;
  }

  maxCorrections(max: number): this {
    this.scenario.maxCorrections = max;
    return this;
  }

  addCorrection(correction: CorrectionPoint): this {
    if (!this.scenario.correctionPoints) {
      this.scenario.correctionPoints = [];
    }
    this.scenario.correctionPoints.push(correction);
    return this;
  }

  addCriterion(criterion: SuccessCriterion): this {
    if (!this.scenario.successCriteria) {
      this.scenario.successCriteria = [];
    }
    this.scenario.successCriteria.push(criterion);
    return this;
  }

  build(): ValidationScenario {
    // Validate required fields
    const required = [
      "id",
      "name",
      "description",
      "difficulty",
      "category",
      "projectTemplate",
      "initialPrompt",
      "persona",
      "knowledgeBase",
      "expectedTools",
      "maxToolCalls",
      "maxCorrections",
    ];

    for (const field of required) {
      if (!(field in this.scenario)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Set defaults
    if (!this.scenario.correctionPoints) {
      this.scenario.correctionPoints = [];
    }
    if (!this.scenario.successCriteria) {
      this.scenario.successCriteria = [];
    }

    return this.scenario as ValidationScenario;
  }
}

/**
 * Create a new scenario builder
 */
export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}
