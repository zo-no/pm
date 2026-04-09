export type OpportunityStatus =
  | "new"
  | "observing"
  | "candidate"
  | "planned"
  | "dispatched"
  | "evaluating"
  | "accepted"
  | "rejected"
  | "parked";

export interface Opportunity {
  id: string;
  source: string;
  title: string;
  problem: string;
  linkedSignalIds: string[];
  sourceSessionIds: string[];
  primarySessionId?: string;
  sourceRunIds: string[];
  impactedUsers: number;
  impactScore: number;
  confidenceScore: number;
  effortScore: number;
  riskScore: number;
  strategyFit: number;
  priorityScore: number;
  status: OpportunityStatus;
}
