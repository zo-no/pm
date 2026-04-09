import type { Decision } from "../domain/decision.js";
import type { Clock } from "../ports/clock.js";
import type { LLMClient } from "../ports/llm.js";
import type { OutcomeReader } from "../ports/outcome-reader.js";
import type { StateStore } from "../ports/state-store.js";

export const evaluateUseCase = async (
  deps: {
    clock: Clock;
    llm?: LLMClient;
    outcomeReader: OutcomeReader;
    stateStore: StateStore;
  }
): Promise<{ decisions: Decision[] }> => {
  const experiments = await deps.stateStore.listExperiments();
  const opportunities = await deps.stateStore.listOpportunities();
  const decisions: Decision[] = [];

  for (const experiment of experiments.filter((item) => item.status === "running")) {
    const outcome = await deps.outcomeReader.fetchOutcome({ experimentId: experiment.id });
    if (outcome.status === "running") continue;
    const opportunity = opportunities.find((item) => item.id === experiment.opportunityId);
    if (!opportunity) continue;
    const llmDecision: Pick<Decision, "outcome" | "reason"> = deps.llm
      ? await deps.llm.evaluateExperiment({
          opportunity,
          experiment,
          outcome
        })
      : {
          outcome: outcome.status === "finished" ? "accepted" : "rejected",
          reason: outcome.summary ?? `Experiment ended with status ${outcome.status}`
        };
    const decision: Decision = {
      id: `decision:${experiment.id}:${deps.clock.isoNow()}`,
      experimentId: experiment.id,
      opportunityId: opportunity.id,
      outcome: llmDecision.outcome,
      reason: llmDecision.reason,
      ts: deps.clock.isoNow()
    };
    decisions.push(decision);
    await deps.stateStore.saveExperiment({
      ...experiment,
      status: llmDecision.outcome === "accepted" ? "accepted" : "rejected",
      summary: outcome.summary ?? experiment.summary,
      metricDelta: outcome.metrics
    });
    await deps.stateStore.upsertOpportunities([
      {
        ...opportunity,
        status: llmDecision.outcome
      }
    ]);
    await deps.stateStore.appendDecision(decision);
  }

  return { decisions };
};
