import type { ProjectTarget } from "../domain/project-target.js";

export interface TargetRegistry {
  listTargets(): Promise<ProjectTarget[]>;
  getTarget(targetId: string): Promise<ProjectTarget | undefined>;
}
