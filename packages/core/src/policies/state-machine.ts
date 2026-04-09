import type { ExperimentStatus } from "../domain/experiment.js";
import type { OpportunityStatus } from "../domain/opportunity.js";

const opportunityTransitions: Record<OpportunityStatus, OpportunityStatus[]> = {
  new: ["observing", "candidate", "parked"],
  observing: ["candidate", "parked"],
  candidate: ["planned", "parked", "rejected"],
  planned: ["dispatched", "parked"],
  dispatched: ["evaluating", "rejected"],
  evaluating: ["accepted", "rejected", "parked"],
  accepted: [],
  rejected: [],
  parked: ["candidate", "planned"]
};

const experimentTransitions: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ["running", "canceled"],
  running: ["finished", "failed", "canceled"],
  finished: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
  failed: [],
  canceled: []
};

export const assertOpportunityTransition = (
  current: OpportunityStatus,
  next: OpportunityStatus
): OpportunityStatus => {
  if (!opportunityTransitions[current].includes(next)) {
    throw new Error(`Invalid opportunity transition: ${current} -> ${next}`);
  }
  return next;
};

export const assertExperimentTransition = (
  current: ExperimentStatus,
  next: ExperimentStatus
): ExperimentStatus => {
  if (!experimentTransitions[current].includes(next)) {
    throw new Error(`Invalid experiment transition: ${current} -> ${next}`);
  }
  return next;
};
