import type { ChangeProposal, ProposalChangeType, ProposalRiskLevel } from "../domain/change-proposal.js";
import type { Clock } from "../ports/clock.js";
import type { ApprovalGate } from "../ports/approval-gate.js";
import type { StateStore } from "../ports/state-store.js";
import type { TargetRegistry } from "../ports/target-registry.js";

const deriveRiskLevel = (riskScore: number): ProposalRiskLevel => {
  if (riskScore >= 0.75) return "high";
  if (riskScore >= 0.45) return "medium";
  return "low";
};

const deriveChangeType = (input: {
  opportunityProblem: string;
  opportunityTitle: string;
  specDesiredBehavior: string;
}): ProposalChangeType => {
  const haystack = [
    input.opportunityTitle,
    input.opportunityProblem,
    input.specDesiredBehavior,
  ]
    .join(" ")
    .toLowerCase();
  if (/(merge|合并)/.test(haystack)) return "merge";
  if (/(remove|delete|cleanup|清理|删除|去掉)/.test(haystack)) return "remove";
  if (/(new|新增|全新|新建)/.test(haystack)) return "new";
  return "extend";
};

export const proposeUseCase = async (
  deps: {
    approvalGate: ApprovalGate;
    clock: Clock;
    stateStore: StateStore;
    targetRegistry: TargetRegistry;
  },
  input: {
    opportunityId: string;
    targetId: string;
  }
): Promise<{ proposal: ChangeProposal }> => {
  const opportunities = await deps.stateStore.listOpportunities();
  const opportunity = opportunities.find((candidate) => candidate.id === input.opportunityId);
  if (!opportunity) {
    throw new Error(`No opportunity found for ${input.opportunityId}`);
  }

  const spec = await deps.stateStore.getSpecByOpportunityId(input.opportunityId);
  if (!spec) {
    throw new Error(`No spec found for opportunity ${input.opportunityId}`);
  }

  const target = await deps.targetRegistry.getTarget(input.targetId);
  if (!target) {
    throw new Error(`No target found for ${input.targetId}`);
  }

  const proposal: ChangeProposal = {
    id: `proposal:${opportunity.id}:${deps.clock.isoNow()}`,
    opportunityId: opportunity.id,
    specId: spec.id,
    targetId: target.id,
    changeType: deriveChangeType({
      opportunityProblem: opportunity.problem,
      opportunityTitle: opportunity.title,
      specDesiredBehavior: spec.desiredBehavior,
    }),
    title: `${opportunity.title} -> ${target.label}`,
    summary: spec.title,
    rationale: opportunity.problem,
    requestedActions: [
      `Work in repository ${target.repoPath} on base branch ${target.baseBranch}.`,
      `Implement the spec trigger "${spec.trigger}" with the desired behavior captured in the spec.`,
      ...(target.executionPolicy.requireTests ? ["Run the required tests or checks before returning a result."] : []),
      "Return a branch-level result for human review instead of direct merge."
    ],
    riskLevel: deriveRiskLevel(opportunity.riskScore),
    status: "queued",
    createdAt: deps.clock.isoNow()
  };

  return deps.approvalGate.submitProposal({ proposal });
};
