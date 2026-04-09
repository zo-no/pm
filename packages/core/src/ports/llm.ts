import type { DecisionOutcome, Decision } from "../domain/decision.js";
import type { Experiment, ExperimentOutcome } from "../domain/experiment.js";
import type { Opportunity } from "../domain/opportunity.js";
import type { PatternReference } from "../domain/pattern.js";
import type { Signal } from "../domain/signal.js";
import type { SpecDraft } from "../domain/spec.js";

export interface LLMClient {
  draftSpec(input: { opportunity: Opportunity; signals: Signal[]; patterns?: PatternReference[] }): Promise<SpecDraft>;
  evaluateExperiment(input: {
    opportunity: Opportunity;
    experiment: Experiment;
    outcome: ExperimentOutcome;
  }): Promise<Pick<Decision, "outcome" | "reason">>;
  summarizeOpportunity(input: { opportunity: Opportunity; signals: Signal[] }): Promise<string>;
}

export const defaultDecisionOutcome = (accepted: boolean): DecisionOutcome =>
  accepted ? "accepted" : "rejected";
