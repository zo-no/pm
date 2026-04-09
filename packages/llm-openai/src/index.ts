import type {
  Decision,
  Experiment,
  ExperimentOutcome,
  LLMClient,
  Opportunity,
  PatternReference,
  Signal,
  SpecDraft
} from "@pm-loop/core";

export interface OpenAILLMClientOptions {
  model: string;
}

export class OpenAILLMClient implements LLMClient {
  constructor(private readonly options: OpenAILLMClientOptions) {
    void this.options;
  }

  async draftSpec(_input: { opportunity: Opportunity; signals: Signal[]; patterns?: PatternReference[] }): Promise<SpecDraft> {
    throw new Error("OpenAILLMClient is not implemented yet.");
  }

  async evaluateExperiment(_input: {
    opportunity: Opportunity;
    experiment: Experiment;
    outcome: ExperimentOutcome;
  }): Promise<Pick<Decision, "outcome" | "reason">> {
    throw new Error("OpenAILLMClient is not implemented yet.");
  }

  async summarizeOpportunity(_input: { opportunity: Opportunity; signals: Signal[] }): Promise<string> {
    throw new Error("OpenAILLMClient is not implemented yet.");
  }
}

export class HeuristicLLMClient implements LLMClient {
  async draftSpec(input: { opportunity: Opportunity; signals: Signal[]; patterns?: PatternReference[] }): Promise<SpecDraft> {
    const patterns = input.patterns ?? [];
    const references = patterns.map((pattern) => `${pattern.source}:${pattern.title}`);
    const behaviorSuffix =
      patterns.length > 0
        ? ` Prioritize patterns such as ${patterns.map((pattern) => pattern.title).join(", ")}.`
        : "";
    return {
      id: `spec:${input.opportunity.id}`,
      opportunityId: input.opportunity.id,
      sourceSessionId: input.opportunity.primarySessionId,
      title: `Spec for ${input.opportunity.title}`,
      references,
      userStory: `As a user affected by ${input.opportunity.title}, I want the workflow to close with less friction.`,
      trigger: input.signals[0]?.subject ?? "Unknown trigger",
      desiredBehavior: `The host should provide a first-class branch dispatch flow for this repeated task.${behaviorSuffix}`,
      nonGoals: ["Do not redesign unrelated task flows."],
      acceptanceCriteria: [
        "Users can trigger the flow without repeated clarification.",
        "The tool error signal drops in the next cycle.",
        ...(patterns.length > 0 ? ["The implementation clearly reflects at least one referenced pattern."] : [])
      ],
      telemetryPlan: [
        "Track branch dispatch success rate.",
        "Track repeated clarification count."
      ],
      rollbackPlan: ["Disable the new flow if dispatch failure rate increases."],
      status: "draft"
    };
  }

  async evaluateExperiment(input: {
    opportunity: Opportunity;
    experiment: Experiment;
    outcome: ExperimentOutcome;
  }): Promise<Pick<Decision, "outcome" | "reason">> {
    void input.opportunity;
    void input.experiment;
    return {
      outcome: input.outcome.status === "finished" ? "accepted" : "rejected",
      reason:
        input.outcome.summary ??
        (input.outcome.status === "finished"
          ? "The experiment completed successfully."
          : `The experiment ended with status ${input.outcome.status}.`)
    };
  }

  async summarizeOpportunity(input: { opportunity: Opportunity; signals: Signal[] }): Promise<string> {
    return `${input.opportunity.problem} (signals: ${input.signals.length})`;
  }
}
