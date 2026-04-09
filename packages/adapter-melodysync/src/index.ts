import type {
  ActionRunner,
  Event,
  EventOutcome,
  EventSource,
  EventType,
  Experiment,
  ExperimentOutcome,
  OutcomeReader,
  SpecDraft
} from "@pm-loop/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface MelodySyncHostEvent {
  id: string;
  ts: string;
  kind: string;
  sessionId?: string;
  runId?: string;
  payload: Record<string, unknown>;
  outcome?: string;
  durationMs?: number;
  retryCount?: number;
}

export interface MelodySyncHostApi {
  fetchSessionEvents(input: {
    since: string;
    cursor?: string;
  }): Promise<{
    events: MelodySyncHostEvent[];
    nextCursor?: string;
  }>;
  createBranchExperiment(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{
    experimentId: string;
    hostRefs: string[];
    summary?: string;
  }>;
  readExperimentOutcome(input: {
    experimentId: string;
  }): Promise<ExperimentOutcome>;
}

export interface MelodySyncRuntimeAdapterOptions {
  runtimeRoot?: string;
  maxSessions?: number;
  projectRoot?: string;
  baseUrl?: string;
}

const mapEventType = (kind: string): EventType => {
  switch (kind) {
    case "user_message":
      return "user_intent";
    case "agent_plan":
      return "agent_plan";
    case "tool_call":
      return "tool_call";
    case "tool_error":
      return "tool_error";
    case "user_correction":
      return "user_correction";
    case "branch_spawned":
      return "branch_spawned";
    case "task_completed":
      return "task_completed";
    case "task_abandoned":
      return "task_abandoned";
    default:
      return "explicit_feedback";
  }
};

const mapOutcome = (value?: string): EventOutcome => {
  if (value === "success") return "success";
  if (value === "failure") return "failure";
  if (value === "neutral") return "neutral";
  return "unknown";
};

export class MelodySyncEventSource implements EventSource {
  constructor(private readonly api: MelodySyncHostApi) {}

  async fetchEvents(input: { since: string; cursor?: string }): Promise<{ events: Event[]; nextCursor?: string }> {
    const { events, nextCursor } = await this.api.fetchSessionEvents(input);
    return {
      events: events.map((event) => ({
        id: event.id,
        ts: event.ts,
        source: "melodysync",
        actor: "system",
        type: mapEventType(event.kind),
        subject: typeof event.payload.topic === "string" ? event.payload.topic : "session-flow",
        sessionId: event.sessionId,
        runId: event.runId,
        outcome: mapOutcome(event.outcome),
        durationMs: event.durationMs,
        retryCount: event.retryCount,
        tags: ["melodysync"],
        payload: event.payload,
        hostRefs: {
          sessionId: event.sessionId ?? "",
          runId: event.runId ?? ""
        }
      })),
      nextCursor
    };
  }
}

export class MelodySyncActionRunner implements ActionRunner {
  constructor(private readonly api: MelodySyncHostApi) {}

  async dispatchPlan(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{ experiment: Experiment }> {
    const result = await this.api.createBranchExperiment(input);
    return {
      experiment: {
        id: result.experimentId,
        opportunityId: input.opportunityId,
        specId: input.spec.id,
        mode: input.mode,
        owner: "melodysync-adapter",
        hostRefs: result.hostRefs,
        status: "draft",
        summary: result.summary
      }
    };
  }
}

export class MelodySyncOutcomeReader implements OutcomeReader {
  constructor(private readonly api: MelodySyncHostApi) {}

  fetchOutcome(input: { experimentId: string }): Promise<ExperimentOutcome> {
    return this.api.readExperimentOutcome(input);
  }
}

export const createMelodySyncAdapter = (api: MelodySyncHostApi) => ({
  eventSource: new MelodySyncEventSource(api),
  actionRunner: new MelodySyncActionRunner(api),
  outcomeReader: new MelodySyncOutcomeReader(api)
});

const defaultRuntimeRoot = () => join(homedir(), ".melodysync", "runtime");

type MelodySyncCatalogSession = {
  id: string;
  name?: string;
  updatedAt?: string;
  activeRunId?: string | null;
  internalRole?: string;
  archived?: boolean;
  taskCard?: {
    goal?: string;
    summary?: string;
    checkpoint?: string;
  };
};

type HistoryEventRecord = {
  type?: string;
  id?: string;
  timestamp?: number;
  role?: string;
  content?: string;
  toolName?: string;
  exitCode?: number;
  runId?: string;
  requestId?: string;
  filePath?: string;
  changeType?: string;
  statusKind?: string;
  hookOutcome?: string;
};

const toIso = (value?: number): string => new Date(value ?? Date.now()).toISOString();

const sessionSubject = (session: MelodySyncCatalogSession): string =>
  session.taskCard?.goal || session.name || session.id;

const mapHistoryEvent = (
  session: MelodySyncCatalogSession,
  record: HistoryEventRecord
): Event | null => {
  const base = {
    id: record.id ?? `${session.id}:${record.timestamp ?? Date.now()}`,
    ts: toIso(record.timestamp),
    source: "melodysync",
    subject: sessionSubject(session),
    sessionId: session.id,
    runId: record.runId,
    tags: ["melodysync", record.type ?? "unknown"],
    hostRefs: {
      sessionId: session.id,
      runId: record.runId ?? ""
    }
  } satisfies Partial<Event>;

  if (record.type === "message" && record.role === "user") {
    return {
      ...base,
      actor: "user",
      type: "user_intent",
      outcome: "unknown",
      payload: {
        content: record.content ?? ""
      }
    };
  }

  if (record.type === "tool_use") {
    return {
      ...base,
      actor: "agent",
      type: "tool_call",
      target: record.toolName,
      outcome: "unknown",
      payload: {
        toolName: record.toolName ?? ""
      }
    };
  }

  if (record.type === "tool_result" && typeof record.exitCode === "number" && record.exitCode !== 0) {
    return {
      ...base,
      actor: "system",
      type: "tool_error",
      target: record.toolName,
      outcome: "failure",
      payload: {
        toolName: record.toolName ?? "",
        exitCode: record.exitCode
      }
    };
  }

  if (record.type === "file_change") {
    return {
      ...base,
      actor: "system",
      type: "task_completed",
      target: record.filePath,
      outcome: "success",
      payload: {
        filePath: record.filePath ?? "",
        changeType: record.changeType ?? "unknown"
      }
    };
  }

  if (record.type === "status" && record.hookOutcome === "failed") {
    return {
      ...base,
      actor: "system",
      type: "tool_error",
      target: record.statusKind,
      outcome: "failure",
      payload: {
        statusKind: record.statusKind ?? ""
      }
    };
  }

  return null;
};

export class MelodySyncRuntimeEventSource implements EventSource {
  private readonly runtimeRoot: string;
  private readonly maxSessions: number;

  constructor(options: MelodySyncRuntimeAdapterOptions = {}) {
    this.runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
    this.maxSessions = options.maxSessions ?? 20;
  }

  async fetchEvents(input: { since: string }): Promise<{ events: Event[]; nextCursor?: string }> {
    const catalogPath = join(this.runtimeRoot, "sessions", "chat-sessions.json");
    const historyRoot = join(this.runtimeRoot, "sessions", "history");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as MelodySyncCatalogSession[];
    const sessions = catalog
      .filter((session) => !session.internalRole && session.archived !== true)
      .filter((session) => (session.updatedAt ?? session.id) >= input.since)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, this.maxSessions);

    const events: Event[] = [];
    for (const session of sessions) {
      const eventsDir = join(historyRoot, session.id, "events");
      let files: string[] = [];
      let emittedUserIntent = false;
      const emittedToolErrors = new Set<string>();
      const emittedCompletions = new Set<string>();
      try {
        files = (await readdir(eventsDir)).filter((name) => name.endsWith(".json")).sort();
      } catch {
        continue;
      }
      for (const file of files) {
        const raw = JSON.parse(await readFile(join(eventsDir, file), "utf8")) as HistoryEventRecord;
        const mapped = mapHistoryEvent(session, raw);
        if (!mapped) continue;
        if (mapped.ts < input.since) continue;
        if (mapped.type === "user_intent") {
          if (emittedUserIntent) continue;
          emittedUserIntent = true;
        }
        if (mapped.type === "tool_error") {
          const errorKey = `${mapped.runId ?? "no-run"}:${mapped.target ?? "unknown"}`;
          if (emittedToolErrors.has(errorKey)) continue;
          emittedToolErrors.add(errorKey);
        }
        if (mapped.type === "task_completed") {
          const completionKey = `${mapped.runId ?? "no-run"}:${mapped.target ?? mapped.subject ?? "session"}`;
          if (emittedCompletions.has(completionKey)) continue;
          emittedCompletions.add(completionKey);
        }
        events.push(mapped);
      }
    }

    return { events };
  }
}

export class MelodySyncRuntimeOutcomeReader implements OutcomeReader {
  private readonly runtimeRoot: string;

  constructor(options: MelodySyncRuntimeAdapterOptions = {}) {
    this.runtimeRoot = options.runtimeRoot ?? defaultRuntimeRoot();
  }

  async fetchOutcome(input: { experimentId: string }): Promise<ExperimentOutcome> {
    if (input.experimentId.startsWith("shadow:")) {
      return {
        experimentId: input.experimentId,
        status: "finished",
        summary: "Shadow experiment recorded for review."
      };
    }
    const statusPath = join(this.runtimeRoot, "sessions", "runs", input.experimentId, "status.json");
    const resultPath = join(this.runtimeRoot, "sessions", "runs", input.experimentId, "result.json");
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8")) as {
        state?: string;
        failureReason?: string;
      };
      let result: { assistantMessage?: string } | undefined;
      try {
        result = JSON.parse(await readFile(resultPath, "utf8")) as { assistantMessage?: string };
      } catch {
        result = undefined;
      }
      const state = status.state ?? "running";
      if (state === "failed") {
        return {
          experimentId: input.experimentId,
          status: "failed",
          summary: status.failureReason ?? result?.assistantMessage ?? "Run failed."
        };
      }
      if (["completed", "finished", "done", "succeeded"].includes(state)) {
        return {
          experimentId: input.experimentId,
          status: "finished",
          summary: result?.assistantMessage ?? "Run completed."
        };
      }
      return {
        experimentId: input.experimentId,
        status: "running"
      };
    } catch {
      return {
        experimentId: input.experimentId,
        status: "running"
      };
    }
  }
}

export class MelodySyncShadowActionRunner implements ActionRunner {
  async dispatchPlan(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{ experiment: Experiment }> {
    return {
      experiment: {
        id: `shadow:${input.opportunityId}`,
        opportunityId: input.opportunityId,
        specId: input.spec.id,
        mode: input.mode,
        owner: "melodysync-shadow-runner",
        hostRefs: [],
        status: "draft",
        summary: "Shadow dispatch only. No host action executed."
      }
    };
  }
}

export class ShadowOutcomeReader implements OutcomeReader {
  async fetchOutcome(input: { experimentId: string }): Promise<ExperimentOutcome> {
    return {
      experimentId: input.experimentId,
      status: "finished",
      summary: "Shadow experiment recorded for review."
    };
  }
}

const defaultProjectRoot = (): string => process.env.MELODYSYNC_PROJECT_ROOT || join(homedir(), "code", "melody-sync");
const defaultBaseUrl = (): string => process.env.MELODYSYNC_CHAT_BASE_URL || "http://127.0.0.1:7760";

const buildDelegateTask = (input: { spec: SpecDraft; opportunityId: string }): string => {
  const lines = [
    `Opportunity: ${input.opportunityId}`,
    `Title: ${input.spec.title}`,
    `User story: ${input.spec.userStory}`,
    `Trigger: ${input.spec.trigger}`,
    `Desired behavior: ${input.spec.desiredBehavior}`,
    "",
    "Acceptance criteria:",
    ...input.spec.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Non-goals:",
    ...input.spec.nonGoals.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Telemetry plan:",
    ...input.spec.telemetryPlan.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Rollback plan:",
    ...input.spec.rollbackPlan.map((item, index) => `${index + 1}. ${item}`)
  ];
  return lines.join("\n");
};

export class MelodySyncCliActionRunner implements ActionRunner {
  private readonly projectRoot: string;
  private readonly baseUrl: string;

  constructor(options: MelodySyncRuntimeAdapterOptions = {}) {
    this.projectRoot = options.projectRoot ?? defaultProjectRoot();
    this.baseUrl = options.baseUrl ?? defaultBaseUrl();
  }

  async dispatchPlan(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{ experiment: Experiment }> {
    if (!input.sourceSessionId) {
      throw new Error(`No source session id available for opportunity ${input.opportunityId}`);
    }
    const cliPath = join(this.projectRoot, "cli.js");
    const args = [
      cliPath,
      "session-spawn",
      "--source-session",
      input.sourceSessionId,
      "--task",
      buildDelegateTask({ spec: input.spec, opportunityId: input.opportunityId }),
      "--json",
      "--base-url",
      this.baseUrl
    ];
    const result = await execFileAsync(process.execPath, args, {
      env: {
        ...process.env,
        MELODYSYNC_PROJECT_ROOT: this.projectRoot,
        MELODYSYNC_CHAT_BASE_URL: this.baseUrl
      }
    });
    const parsed = JSON.parse(result.stdout) as {
      sessionId: string;
      runId: string;
      sessionUrl?: string;
      sessionName?: string;
    };
    return {
      experiment: {
        id: parsed.runId,
        opportunityId: input.opportunityId,
        specId: input.spec.id,
        mode: input.mode,
        owner: "melodysync-cli-runner",
        hostRefs: [parsed.sessionId],
        status: "draft",
        summary: `Spawned child session ${parsed.sessionId}${parsed.sessionName ? ` (${parsed.sessionName})` : ""}.`
      }
    };
  }
}
