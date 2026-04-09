import type { DispatchMode } from "./experiment.js";

export type ApprovalPolicy = "always_human" | "threshold_based";

export interface ProjectTarget {
  id: string;
  label: string;
  product: string;
  repoPath: string;
  baseBranch: string;
  telemetrySources: string[];
  approvalPolicy: ApprovalPolicy;
  defaultExecutionMode: DispatchMode;
  executionPolicy: {
    allowDirectApply: boolean;
    allowAutoMerge: boolean;
    requireTests: boolean;
    maxChangedFiles?: number;
    writablePaths?: string[];
  };
}
