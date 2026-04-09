export type DispatchMode = "shadow" | "assist" | "guarded";

export type ExperimentStatus =
  | "draft"
  | "running"
  | "finished"
  | "accepted"
  | "rejected"
  | "failed"
  | "canceled";

export interface Experiment {
  id: string;
  opportunityId: string;
  specId: string;
  mode: DispatchMode;
  owner: string;
  hostRefs: string[];
  status: ExperimentStatus;
  summary?: string;
  metricDelta?: Record<string, number>;
}

export interface ExperimentOutcome {
  experimentId: string;
  status: "running" | "finished" | "failed" | "canceled";
  metrics?: Record<string, number>;
  artifacts?: string[];
  summary?: string;
}
