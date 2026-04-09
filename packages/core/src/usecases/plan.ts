import type { Opportunity } from "../domain/opportunity.js";
import type { Signal } from "../domain/signal.js";
import type { SpecDraft } from "../domain/spec.js";
import { calculatePriorityScore } from "../policies/scoring.js";
import type { Clock } from "../ports/clock.js";
import type { LLMClient } from "../ports/llm.js";
import type { PatternSource } from "../ports/pattern-source.js";
import type { StateStore } from "../ports/state-store.js";
import type { PatternReference } from "../domain/pattern.js";

const makeOpportunity = (signal: Signal): Opportunity => {
  const impactScore = Number((signal.frequency * signal.severity).toFixed(2));
  const confidenceScore = signal.confidence;
  const effortScore = signal.signalType === "tool_chain_break" ? 0.8 : 0.5;
  const riskScore = signal.signalType === "user_rejection" ? 0.8 : 0.4;
  const strategyFit = signal.signalType === "high_frequency_request" ? 1 : 0.7;
  return {
    id: `opp:${signal.id}`,
    source: signal.source,
    title: `${signal.signalType}:${signal.subject}`,
    problem: `Recurring product issue detected for ${signal.subject}`,
    linkedSignalIds: [signal.id],
    sourceSessionIds: signal.sessionIds,
    primarySessionId: signal.sessionIds[0],
    sourceRunIds: signal.runIds,
    impactedUsers: signal.frequency,
    impactScore,
    confidenceScore,
    effortScore,
    riskScore,
    strategyFit,
    priorityScore: calculatePriorityScore({
      impactScore,
      confidenceScore,
      effortScore,
      riskScore,
      strategyFit
    }),
    status: "candidate"
  };
};

const fallbackSpec = (
  opportunity: Opportunity,
  signals: Signal[],
  patterns: PatternReference[],
  now: string
): SpecDraft => ({
  id: `spec:${opportunity.id}:${now}`,
  opportunityId: opportunity.id,
  sourceSessionId: opportunity.primarySessionId,
  title: opportunity.title,
  references: patterns.map((pattern) => `${pattern.source}:${pattern.title}`),
  userStory: `As a user affected by ${opportunity.title}, I want the system to reduce repeat friction.`,
  trigger: signals[0]?.subject ?? "Recurring signal detected",
  desiredBehavior:
    patterns.length > 0
      ? `The host product should reduce the observed failure or clarification loop using patterns such as ${patterns
          .map((pattern) => pattern.title)
          .join(", ")}.`
      : "The host product should reduce the observed failure or clarification loop.",
  nonGoals: ["Do not expand scope beyond the observed workflow."],
  acceptanceCriteria: [
    "The triggering signal frequency decreases in the next observation window.",
    "The workflow can be executed with fewer manual corrections.",
    ...(patterns.length > 0 ? [`Adopt at least one referenced pattern in the shipped flow.`] : [])
  ],
  telemetryPlan: [
    "Track the triggering signal count before and after the experiment.",
    "Record experiment outcome and rollback reason if needed."
  ],
  rollbackPlan: [
    "Disable the experiment path in the host product.",
    "Mark the opportunity as parked if the metric delta is neutral or negative."
  ],
  status: "draft"
});

export const planUseCase = async (
  deps: {
    clock: Clock;
    llm?: LLMClient;
    patternSource?: PatternSource;
    stateStore: StateStore;
  },
  input: { source?: string; limit?: number; preferredOpportunityId?: string } = {}
): Promise<{ opportunities: Opportunity[]; spec?: SpecDraft }> => {
  const signals = await deps.stateStore.listSignals({
    statuses: ["new", "observing", "promoted"],
    source: input.source
  });
  const existingOpportunities = await deps.stateStore.listOpportunities({ source: input.source });
  const existingExperiments = await deps.stateStore.listExperiments();
  const existingById = new Map(existingOpportunities.map((opportunity) => [opportunity.id, opportunity]));
  const opportunities = signals
    .map((signal) => {
      const fresh = makeOpportunity(signal);
      const existing = existingById.get(fresh.id);
      const hasRunningExperiment = existingExperiments.some(
        (experiment) => experiment.opportunityId === fresh.id && experiment.status === "running"
      );
      return existing
        ? {
            ...fresh,
            status: hasRunningExperiment ? "evaluating" : existing.status
          }
        : {
            ...fresh,
            status: hasRunningExperiment ? "evaluating" : fresh.status
          };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const limited = opportunities.slice(0, input.limit ?? 5);
  await deps.stateStore.upsertOpportunities(limited);

  const top = limited[0];
  if (!top) {
    return { opportunities: [] };
  }

  const specTarget = limited.find((opportunity) => opportunity.id === input.preferredOpportunityId) ?? top;
  const linkedSignals = signals.filter((signal) => specTarget.linkedSignalIds.includes(signal.id));
  const patterns = deps.patternSource
    ? await deps.patternSource.findPatterns({
        opportunity: specTarget,
        signals: linkedSignals,
        limit: 3
      })
    : [];
  const spec = deps.llm
    ? await deps.llm.draftSpec({ opportunity: specTarget, signals: linkedSignals, patterns })
    : fallbackSpec(specTarget, linkedSignals, patterns, deps.clock.isoNow());
  await deps.stateStore.saveSpec(spec);
  await deps.stateStore.upsertOpportunities([
    {
      ...specTarget,
      status: ["dispatched", "evaluating", "accepted", "rejected", "parked"].includes(specTarget.status)
        ? specTarget.status
        : "planned"
    }
  ]);
  return {
    opportunities: limited,
    spec
  };
};
