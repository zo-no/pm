import type { ApprovalOutcome, ApprovalRecord, ChangeProposal, ProposalStatus } from "../domain/change-proposal.js";

export interface ApprovalGate {
  submitProposal(input: { proposal: ChangeProposal }): Promise<{ proposal: ChangeProposal }>;
  listPendingProposals(): Promise<ChangeProposal[]>;
  listProposals(input?: {
    opportunityId?: string;
    status?: ProposalStatus[];
    targetId?: string;
  }): Promise<ChangeProposal[]>;
  recordApproval(input: {
    proposalId: string;
    outcome: ApprovalOutcome;
    actor: string;
    note?: string;
  }): Promise<ApprovalRecord>;
  getLatestApproval(proposalId: string): Promise<ApprovalRecord | undefined>;
}
