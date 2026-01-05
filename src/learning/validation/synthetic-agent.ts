/**
 * Synthetic Agent
 *
 * Simulates user behavior during validation sessions.
 * Handles agent queries, injects corrections, and maintains persona consistency.
 *
 * @module learning/validation/synthetic-agent
 */

import type {
  ValidationScenario,
  UserPersona,
  ScenarioKnowledgeBase,
  CorrectionPoint,
  CorrectionTrigger,
  ToolEvent,
  AgentResponse,
} from "./types.js";
import type { SessionRecorder } from "./session-recorder.js";

// ============================================================================
// Synthetic Agent
// ============================================================================

/**
 * Simulates a user interacting with the agent under test.
 * Handles queries based on knowledge base and persona.
 */
export class SyntheticAgent {
  private scenario: ValidationScenario;
  private persona: UserPersona;
  private knowledgeBase: ScenarioKnowledgeBase;
  private queryHandler: QueryHandler;
  private correctionInjector: CorrectionInjector;
  private sessionRecorder: SessionRecorder;

  private interactionCount = 0;
  private correctionCount = 0;
  private abandonThreshold: number;

  constructor(
    scenario: ValidationScenario,
    sessionRecorder: SessionRecorder
  ) {
    this.scenario = scenario;
    this.persona = scenario.persona;
    this.knowledgeBase = scenario.knowledgeBase;
    this.sessionRecorder = sessionRecorder;

    this.queryHandler = new QueryHandler(
      this.knowledgeBase,
      this.persona
    );

    this.correctionInjector = new CorrectionInjector(
      scenario.correctionPoints,
      this.persona
    );

    // Calculate abandon threshold based on patience
    this.abandonThreshold = Math.ceil(
      scenario.maxCorrections * (1 + this.persona.patience)
    );
  }

  // ============================================================================
  // Main Interaction Loop
  // ============================================================================

  /**
   * Process an agent response and generate user reply
   */
  async processAgentResponse(
    response: AgentResponse,
    toolEvents: readonly ToolEvent[]
  ): Promise<SyntheticResponse> {
    this.interactionCount++;

    // Check for abandonment
    if (this.shouldAbandon()) {
      return this.createAbandonResponse();
    }

    // Check if agent asked a question
    if (response.isQuestion && response.question) {
      const answer = this.queryHandler.handleQuery(response.question);

      this.sessionRecorder.recordUserResponse({
        type: "clarification",
        question: response.question,
        answer: answer.text,
      });

      return {
        type: "answer",
        content: answer.text,
        shouldContinue: true,
      };
    }

    // Check for correction triggers
    const correction = this.correctionInjector.checkTriggers(
      toolEvents,
      response
    );

    if (correction) {
      this.correctionCount++;

      this.sessionRecorder.recordCorrection(
        correction.trigger,
        correction.message
      );

      this.sessionRecorder.recordUserResponse({
        type: "correction",
        answer: correction.message,
      });

      return {
        type: "correction",
        content: correction.message,
        shouldContinue: true,
      };
    }

    // Normal acknowledgment
    const ack = this.generateAcknowledgment(response);

    this.sessionRecorder.recordUserResponse({
      type: "acknowledgment",
      answer: ack,
    });

    return {
      type: "acknowledgment",
      content: ack,
      shouldContinue: this.shouldContinue(response, toolEvents),
    };
  }

  /**
   * Get the initial prompt for the scenario
   */
  getInitialPrompt(): string {
    return this.applyPersonaStyle(this.scenario.initialPrompt);
  }

  // ============================================================================
  // Response Generation
  // ============================================================================

  private generateAcknowledgment(response: AgentResponse): string {
    const acks = this.getAcknowledgments();
    const idx = this.interactionCount % acks.length;
    return acks[idx];
  }

  private getAcknowledgments(): string[] {
    switch (this.persona.verbosity) {
      case "terse":
        return ["ok", "yes", "continue", "good"];
      case "verbose":
        return [
          "That looks good, please continue.",
          "Great progress! Keep going.",
          "I understand. Please proceed with the next step.",
          "Excellent work so far. What's next?",
        ];
      default:
        return [
          "Okay, continue.",
          "Sounds good.",
          "Got it, proceed.",
          "That works.",
        ];
    }
  }

  private applyPersonaStyle(text: string): string {
    switch (this.persona.verbosity) {
      case "terse":
        // Keep it short
        return text.split(".")[0];
      case "verbose":
        // Add context
        return `${text} Please explain your approach as you go.`;
      default:
        return text;
    }
  }

  private createAbandonResponse(): SyntheticResponse {
    const messages: Record<string, string> = {
      polite:
        "I appreciate your effort, but I think we should stop here. This isn't working out.",
      direct:
        "Let's stop. Too many issues. I'll try a different approach.",
      frustrated:
        "Forget it. This is taking too long and not going anywhere.",
    };

    return {
      type: "abandon",
      content: messages[this.persona.correctionStyle],
      shouldContinue: false,
    };
  }

  // ============================================================================
  // State Checks
  // ============================================================================

  private shouldAbandon(): boolean {
    return this.correctionCount >= this.abandonThreshold;
  }

  private shouldContinue(
    response: AgentResponse,
    toolEvents: readonly ToolEvent[]
  ): boolean {
    // Check if we've hit tool limits
    if (toolEvents.length >= this.scenario.maxToolCalls) {
      return false;
    }

    // Check if agent seems stuck (no tool calls in last response)
    if (response.toolCalls.length === 0 && !response.isQuestion) {
      // Agent might be done or stuck
      return false;
    }

    return true;
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  getInteractionCount(): number {
    return this.interactionCount;
  }

  getCorrectionCount(): number {
    return this.correctionCount;
  }

  getPersona(): UserPersona {
    return this.persona;
  }
}

// ============================================================================
// Query Handler
// ============================================================================

/**
 * Handles agent clarifying questions using the scenario knowledge base.
 */
export class QueryHandler {
  private knowledgeBase: ScenarioKnowledgeBase;
  private persona: UserPersona;
  private defaultAnswers: Map<string, string>;

  constructor(knowledgeBase: ScenarioKnowledgeBase, persona: UserPersona) {
    this.knowledgeBase = knowledgeBase;
    this.persona = persona;
    this.defaultAnswers = this.buildDefaultAnswers();
  }

  /**
   * Handle a query from the agent
   */
  handleQuery(question: string): QueryAnswer {
    const lowerQuestion = question.toLowerCase();

    // Check custom answers first
    if (this.knowledgeBase.customAnswers) {
      for (const [key, value] of Object.entries(
        this.knowledgeBase.customAnswers
      )) {
        if (lowerQuestion.includes(key.toLowerCase())) {
          return this.formatAnswer(value, "custom");
        }
      }
    }

    // Check knowledge base fields
    const kbAnswer = this.checkKnowledgeBase(lowerQuestion);
    if (kbAnswer) {
      return this.formatAnswer(kbAnswer, "knowledge_base");
    }

    // Check default answers
    for (const [pattern, answer] of this.defaultAnswers) {
      if (lowerQuestion.includes(pattern)) {
        return this.formatAnswer(answer, "default");
      }
    }

    // Fallback: express uncertainty based on expertise
    return this.handleUnknownQuery(question);
  }

  private checkKnowledgeBase(question: string): string | null {
    const kb = this.knowledgeBase;

    // Language questions
    if (
      question.includes("language") ||
      question.includes("typescript") ||
      question.includes("javascript")
    ) {
      if (kb.language) return kb.language;
    }

    // Package manager questions
    if (
      question.includes("package manager") ||
      question.includes("npm") ||
      question.includes("yarn") ||
      question.includes("pnpm")
    ) {
      if (kb.packageManager) return `Use ${kb.packageManager}`;
    }

    // Framework questions
    if (
      question.includes("framework") ||
      question.includes("react") ||
      question.includes("vue")
    ) {
      if (kb.framework) return kb.framework;
    }

    // Testing questions
    if (
      question.includes("test") ||
      question.includes("jest") ||
      question.includes("vitest")
    ) {
      if (kb.testFramework) return `Use ${kb.testFramework}`;
    }

    // Style questions
    if (
      question.includes("style") ||
      question.includes("component") ||
      question.includes("functional") ||
      question.includes("class")
    ) {
      if (kb.componentStyle)
        return `Use ${kb.componentStyle} components`;
    }

    // State management
    if (
      question.includes("state") ||
      question.includes("redux") ||
      question.includes("zustand")
    ) {
      if (kb.stateManagement) return `Use ${kb.stateManagement}`;
    }

    // Node version
    if (question.includes("node") && question.includes("version")) {
      if (kb.nodeVersion) return `Node ${kb.nodeVersion}`;
    }

    // Deploy target
    if (
      question.includes("deploy") ||
      question.includes("hosting") ||
      question.includes("production")
    ) {
      if (kb.deployTarget) return kb.deployTarget;
    }

    return null;
  }

  private buildDefaultAnswers(): Map<string, string> {
    return new Map([
      ["permission", "Yes, you have permission."],
      ["proceed", "Yes, please proceed."],
      ["continue", "Yes, continue."],
      ["confirm", "Confirmed."],
      ["approve", "Approved."],
      ["file name", "Use a descriptive name that matches the convention."],
      ["location", "Put it in the appropriate directory."],
      ["dependency", "Yes, install what's needed."],
      ["breaking change", "That's acceptable if necessary."],
    ]);
  }

  private handleUnknownQuery(question: string): QueryAnswer {
    switch (this.persona.expertiseLevel) {
      case "expert":
        return {
          text: "Use your best judgment. I trust your expertise.",
          confidence: 0.5,
          source: "expertise_delegation",
        };
      case "intermediate":
        return {
          text: "I'm not sure about that specific detail. What would you recommend?",
          confidence: 0.3,
          source: "uncertainty",
        };
      case "novice":
        return {
          text: "I don't know much about that. Can you explain what the options are?",
          confidence: 0.2,
          source: "uncertainty",
        };
    }
  }

  private formatAnswer(
    content: string,
    source: string
  ): QueryAnswer {
    let text = content;

    // Apply verbosity
    switch (this.persona.verbosity) {
      case "terse":
        text = content.split(".")[0];
        break;
      case "verbose":
        text = `${content} Let me know if you need any more details about this.`;
        break;
    }

    return {
      text,
      confidence: 1.0,
      source,
    };
  }
}

export interface QueryAnswer {
  text: string;
  confidence: number;
  source: string;
}

// ============================================================================
// Correction Injector
// ============================================================================

/**
 * Monitors session state and injects corrections based on triggers.
 */
export class CorrectionInjector {
  private correctionPoints: CorrectionPoint[];
  private persona: UserPersona;
  private triggeredCorrections: Set<number> = new Set();
  private randomSeed: number;

  constructor(correctionPoints: CorrectionPoint[], persona: UserPersona) {
    this.correctionPoints = correctionPoints;
    this.persona = persona;
    this.randomSeed = Date.now();
  }

  /**
   * Check if any correction triggers are met
   */
  checkTriggers(
    toolEvents: readonly ToolEvent[],
    response: AgentResponse
  ): CorrectionResult | null {
    for (let i = 0; i < this.correctionPoints.length; i++) {
      // Skip already triggered corrections (one-shot)
      if (this.triggeredCorrections.has(i)) {
        continue;
      }

      const point = this.correctionPoints[i];
      const triggered = this.evaluateTrigger(
        point.trigger,
        toolEvents,
        response
      );

      if (triggered) {
        this.triggeredCorrections.add(i);
        return {
          trigger: point.trigger,
          message: this.formatCorrection(point.correction),
          expectedRecovery: point.expectedRecovery,
        };
      }
    }

    return null;
  }

  private evaluateTrigger(
    trigger: CorrectionTrigger,
    toolEvents: readonly ToolEvent[],
    response: AgentResponse
  ): boolean {
    switch (trigger.type) {
      case "tool_count":
        return toolEvents.length >= trigger.threshold;

      case "wrong_tool":
        return toolEvents.some((e) => e.toolName === trigger.tool);

      case "file_not_found":
        return toolEvents.some(
          (e) =>
            !e.success &&
            e.errorMessage?.includes("not found") &&
            e.errorMessage?.includes(trigger.pattern)
        );

      case "file_contains":
        // Would need to check file content - simplified here
        return response.content.includes(trigger.pattern);

      case "error":
        return toolEvents.some(
          (e) =>
            !e.success &&
            e.errorMessage?.includes(trigger.errorType)
        );

      case "random":
        // Deterministic random based on seed and event count
        const hash = this.hashCode(`${this.randomSeed}_${toolEvents.length}`);
        return (hash % 100) / 100 < trigger.probability;

      default:
        return false;
    }
  }

  private formatCorrection(correction: string): string {
    const prefix = this.getCorrectionPrefix();
    return `${prefix} ${correction}`;
  }

  private getCorrectionPrefix(): string {
    switch (this.persona.correctionStyle) {
      case "polite":
        return "I think there might be an issue.";
      case "direct":
        return "That's not quite right.";
      case "frustrated":
        return "No, that's wrong.";
    }
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  /**
   * Reset for new session
   */
  reset(): void {
    this.triggeredCorrections.clear();
    this.randomSeed = Date.now();
  }
}

export interface CorrectionResult {
  trigger: CorrectionTrigger;
  message: string;
  expectedRecovery: string[];
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface SyntheticResponse {
  type: "answer" | "correction" | "acknowledgment" | "abandon";
  content: string;
  shouldContinue: boolean;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a synthetic agent for a scenario
 */
export function createSyntheticAgent(
  scenario: ValidationScenario,
  sessionRecorder: SessionRecorder
): SyntheticAgent {
  return new SyntheticAgent(scenario, sessionRecorder);
}
