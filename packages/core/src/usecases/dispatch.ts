import type { DispatchMode, Experiment } from "../domain/experiment.js";
import type { Clock } from "../ports/clock.js";
import type { ActionRunner } from "../ports/action-runner.js";
import type { StateStore } from "../ports/state-store.js";

export const dispatchUseCase = async (
  deps: {
    actionRunner: ActionRunner;
    clock: Clock;
    stateStore: StateStore;
  },
  input: {
    opportunityId: string;
    mode?: DispatchMode;
    owner?: string;
  }
): Promise<{ experiment: Experiment }> => {
  const spec = await deps.stateStore.getSpecByOpportunityId(input.opportunityId);
  if (!spec) {
    throw new Error(`No spec found for opportunity ${input.opportunityId}`);
  }

  const { experiment } = await deps.actionRunner.dispatchPlan({
    opportunityId: input.opportunityId,
    spec,
    mode: input.mode ?? "assist",
    sourceSessionId: spec.sourceSessionId
  });
  await deps.stateStore.saveExperiment({
    ...experiment,
    owner: input.owner ?? experiment.owner,
    status: "running",
    summary: experiment.summary ?? `Dispatched at ${deps.clock.isoNow()}`
  });
  const opportunities = await deps.stateStore.listOpportunities();
  const target = opportunities.find((opportunity) => opportunity.id === input.opportunityId);
  if (target) {
    await deps.stateStore.upsertOpportunities([
      {
        ...target,
        status: "dispatched"
      }
    ]);
  }
  return { experiment: { ...experiment, status: "running" } };
};
