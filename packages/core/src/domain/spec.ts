export type SpecStatus = "draft" | "approved" | "superseded";

export interface SpecDraft {
  id: string;
  opportunityId: string;
  sourceSessionId?: string;
  title: string;
  references?: string[];
  userStory: string;
  trigger: string;
  desiredBehavior: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  telemetryPlan: string[];
  rollbackPlan: string[];
  status: SpecStatus;
}
