import type { ProjectTarget, TargetRegistry } from "@pm-loop/core";
import { readFile } from "node:fs/promises";

interface TargetsFile {
  targets?: ProjectTarget[];
}

export interface LocalTargetRegistryOptions {
  filePath: string;
}

export class LocalTargetRegistry implements TargetRegistry {
  constructor(private readonly options: LocalTargetRegistryOptions) {}

  private async readTargets(): Promise<ProjectTarget[]> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      const parsed = JSON.parse(raw) as TargetsFile;
      return Array.isArray(parsed.targets) ? parsed.targets : [];
    } catch {
      return [];
    }
  }

  async listTargets(): Promise<ProjectTarget[]> {
    return this.readTargets();
  }

  async getTarget(targetId: string): Promise<ProjectTarget | undefined> {
    const targets = await this.readTargets();
    return targets.find((target) => target.id === targetId);
  }
}
