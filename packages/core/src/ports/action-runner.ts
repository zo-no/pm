import type { Experiment } from "../domain/experiment.js";
import type { SpecDraft } from "../domain/spec.js";

// Transitional host-dispatch boundary used by the current runtime.
// The target architecture routes execution through:
// ApprovalGate -> TargetRegistry -> ExecutionRunner.
export interface ActionRunner {
  dispatchPlan(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{
    experiment: Experiment;
  }>;
}
