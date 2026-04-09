import type { ChangeProposal } from "../domain/change-proposal.js";
import type { DispatchMode, Experiment } from "../domain/experiment.js";
import type { ProjectTarget } from "../domain/project-target.js";
import type { SpecDraft } from "../domain/spec.js";

export interface ExecutionRunner {
  enqueueExecution(input: {
    target: ProjectTarget;
    proposal: ChangeProposal;
    spec: SpecDraft;
    mode?: DispatchMode;
    owner?: string;
  }): Promise<{
    experiment: Experiment;
  }>;
}
