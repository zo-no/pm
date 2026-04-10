import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LoopMode = "shadow" | "assist" | "guarded";
export type LoopSourceType = "melodysync-runtime" | "peer-only";

export interface LoopProject {
  id: string;
  label: string;
  targetId: string;
  sourceType: LoopSourceType;
  sourceId: string;
  dashboardPort?: number;
  peerProjectIds?: string[];
  runtimeRoot?: string;
}

export interface LoopPaths {
  instanceRoot: string;
  dataDir: string;
  projectDataDir: string;
  stateFile: string;
  approvalStateFile: string;
  sessionMessagesFile: string;
  reportFile: string;
  workerPidPath: string;
  workerLogPath: string;
  patternFile: string;
  targetsFile: string;
  projectsFile: string;
  executionDir: string;
}

export interface LoopConfig {
  mode: LoopMode;
  projectId: string;
  project?: LoopProject;
  paths: LoopPaths;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const projectRootGuess = resolve(moduleDir, "..", "..");

const defaultProjectRoot = (): string => {
  if (existsSync(join(projectRootGuess, "package.json"))) {
    return projectRootGuess;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, "package.json"))) {
    return resolve(cwd);
  }
  return resolve(join(homedir(), "code", "pm-loop"));
};

const buildPaths = (instanceRoot: string, projectId?: string): LoopPaths => {
  const root = resolve(instanceRoot);
  const dataDir = join(root, "data");
  const projectDataDir = projectId ? join(dataDir, "projects", projectId) : dataDir;
  return {
    instanceRoot: root,
    dataDir,
    projectDataDir,
    stateFile: join(projectDataDir, "state.json"),
    approvalStateFile: join(projectDataDir, "approval-state.json"),
    sessionMessagesFile: join(projectDataDir, "session-messages.json"),
    reportFile: join(projectDataDir, "latest-report.md"),
    workerPidPath: join(projectDataDir, "worker.pid"),
    workerLogPath: join(projectDataDir, "worker.log"),
    patternFile: join(root, "catalog", "patterns.json"),
    targetsFile: join(root, "catalog", "targets.json"),
    projectsFile: join(root, "catalog", "projects.json"),
    executionDir: join(projectDataDir, "executions")
  };
};

const readProjectCatalog = (instanceRoot: string): LoopProject[] => {
  const projectsFile = join(instanceRoot, "catalog", "projects.json");
  if (!existsSync(projectsFile)) {
    return [];
  }
  try {
    const raw = readFileSync(projectsFile, "utf8");
    const parsed = JSON.parse(raw) as { projects?: LoopProject[] };
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
};

export const buildProjectPaths = (instanceRoot: string, projectId: string): LoopPaths =>
  buildPaths(instanceRoot, projectId);

export const buildLoopConfig = (options: {
  instanceRoot?: string;
  mode?: LoopMode;
  projectId?: string;
} = {}): LoopConfig => {
  const mode = parseLoopMode(options.mode ?? process.env.PM_LOOP_MODE, "shadow");
  const instanceRoot = resolve(options.instanceRoot ?? process.env.PM_LOOP_ROOT ?? defaultProjectRoot());
  const projects = readProjectCatalog(instanceRoot);
  const requestedProjectId = options.projectId ?? process.env.PM_LOOP_PROJECT_ID;
  const project =
    projects.find((entry) => entry.id === requestedProjectId) ??
    (requestedProjectId ? undefined : projects[0]);
  const projectId = project?.id ?? requestedProjectId ?? "default";
  return {
    mode,
    projectId,
    project,
    paths: buildPaths(instanceRoot, projectId)
  };
};

export const parseLoopMode = (value: string | undefined, fallback: LoopMode = "shadow"): LoopMode => {
  const normalized = value?.toLowerCase();
  if (normalized === "assist" || normalized === "guarded" || normalized === "shadow") {
    return normalized;
  }
  return fallback;
};

export const parseIntEnv = (
  key: string,
  fallback: number,
  options: { min?: number; allowZero?: boolean } = {}
): number => {
  const min = options.min ?? (options.allowZero ? 0 : 1);
  const raw = process.env[key];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
};

export const defaultWindowStart = (days = 7): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

export const parseIsoTimestamp = (input: string | undefined, fallback: string): string => {
  if (!input) {
    return fallback;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
};
