import type { Experiment } from "../domain/experiment.js";
import type { Opportunity, OpportunityStatus } from "../domain/opportunity.js";

const DISPATCHABLE_STATUSES: OpportunityStatus[] = ["candidate", "planned"];

export const isDispatchableOpportunityStatus = (status: OpportunityStatus): boolean =>
  DISPATCHABLE_STATUSES.includes(status);

export const hasRunningExperimentForOpportunity = (
  opportunityId: string,
  experiments: Experiment[]
): boolean => experiments.some((experiment) => experiment.opportunityId === opportunityId && experiment.status === "running");

export const selectDispatchableOpportunity = (
  opportunities: Opportunity[],
  experiments: Experiment[],
  input: { maxActiveExperiments?: number } = {}
): Opportunity | undefined =>
  {
    const maxActiveExperiments = input.maxActiveExperiments ?? 1;
    const activeExperiments = experiments.filter((experiment) => experiment.status === "running").length;
    if (activeExperiments >= maxActiveExperiments) {
      return undefined;
    }
    return opportunities.find(
      (opportunity) =>
        isDispatchableOpportunityStatus(opportunity.status) &&
        !hasRunningExperimentForOpportunity(opportunity.id, experiments)
    );
  };
