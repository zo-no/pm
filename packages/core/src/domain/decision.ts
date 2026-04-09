export type DecisionOutcome = "accepted" | "rejected" | "parked";

export interface Decision {
  id: string;
  experimentId: string;
  opportunityId: string;
  outcome: DecisionOutcome;
  reason: string;
  ts: string;
}
