import type { ApprovalGate, ApprovalOutcome, ApprovalRecord, ChangeProposal, ProposalStatus } from "@pm-loop/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface ApprovalStateFile {
  proposals: ChangeProposal[];
  approvals: ApprovalRecord[];
}

const EMPTY_APPROVAL_STATE: ApprovalStateFile = {
  proposals: [],
  approvals: []
};

const upsertById = <T extends { id: string }>(existing: T[], incoming: T[]): T[] => {
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
};

export interface LocalApprovalGateOptions {
  filePath: string;
}

export class JsonFileApprovalGate implements ApprovalGate {
  constructor(private readonly options: LocalApprovalGateOptions) {}

  private async readState(): Promise<ApprovalStateFile> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      return {
        ...EMPTY_APPROVAL_STATE,
        ...JSON.parse(raw)
      } as ApprovalStateFile;
    } catch {
      return { ...EMPTY_APPROVAL_STATE };
    }
  }

  private async writeState(state: ApprovalStateFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    await writeFile(this.options.filePath, JSON.stringify(state, null, 2));
  }

  async submitProposal(input: { proposal: ChangeProposal }): Promise<{ proposal: ChangeProposal }> {
    const state = await this.readState();
    state.proposals = upsertById(state.proposals, [input.proposal]);
    await this.writeState(state);
    return { proposal: input.proposal };
  }

  async listPendingProposals(): Promise<ChangeProposal[]> {
    return this.listProposals({ status: ["queued"] });
  }

  async listProposals(input: {
    opportunityId?: string;
    status?: ProposalStatus[];
    targetId?: string;
  } = {}): Promise<ChangeProposal[]> {
    const state = await this.readState();
    return state.proposals.filter((proposal) => {
      if (input.opportunityId && proposal.opportunityId !== input.opportunityId) return false;
      if (input.targetId && proposal.targetId !== input.targetId) return false;
      if (input.status?.length && !input.status.includes(proposal.status)) return false;
      return true;
    });
  }

  async recordApproval(input: {
    proposalId: string;
    outcome: ApprovalOutcome;
    actor: string;
    note?: string;
  }): Promise<ApprovalRecord> {
    const state = await this.readState();
    const proposal = state.proposals.find((candidate) => candidate.id === input.proposalId);
    if (!proposal) {
      throw new Error(`No proposal found for ${input.proposalId}`);
    }

    const approval: ApprovalRecord = {
      id: `approval:${input.proposalId}:${Date.now()}`,
      proposalId: input.proposalId,
      outcome: input.outcome,
      actor: input.actor,
      note: input.note,
      ts: new Date().toISOString()
    };

    state.approvals = upsertById(state.approvals, [approval]);
    state.proposals = upsertById(state.proposals, [
      {
        ...proposal,
        status:
          input.outcome === "approved"
            ? "approved"
            : input.outcome === "rejected"
              ? "rejected"
              : input.outcome === "deferred"
                ? "deferred"
                : proposal.status
      }
    ]);
    await this.writeState(state);
    return approval;
  }

  async getLatestApproval(proposalId: string): Promise<ApprovalRecord | undefined> {
    const state = await this.readState();
    return [...state.approvals]
      .filter((approval) => approval.proposalId === proposalId)
      .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  }
}
