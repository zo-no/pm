export type ProposalStatus = "queued" | "approved" | "rejected" | "deferred" | "superseded" | "expired";
export type ProposalRiskLevel = "low" | "medium" | "high";
export type ProposalChangeType = "extend" | "merge" | "remove" | "new";
export type ApprovalOutcome = "approved" | "rejected" | "deferred" | "revised";

export interface ChangeProposal {
  id: string;
  opportunityId: string;
  specId: string;
  targetId: string;
  changeType: ProposalChangeType;
  title: string;
  summary: string;
  rationale: string;
  requestedActions: string[];
  riskLevel: ProposalRiskLevel;
  supersedes?: string[];
  status: ProposalStatus;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  proposalId: string;
  outcome: ApprovalOutcome;
  actor: string;
  note?: string;
  ts: string;
}
