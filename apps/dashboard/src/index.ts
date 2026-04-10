import type { ApprovalOutcome, ChangeProposal, ProjectTarget } from "@pm-loop/core";
import { JsonFileApprovalGate } from "@pm-loop/approval-local";
import { LocalTargetRegistry } from "@pm-loop/targets-local";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { openSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { buildLoopConfig } from "../../shared/config.js";

interface SpecRecord {
  id: string;
  opportunityId: string;
  title: string;
  desiredBehavior: string;
  trigger: string;
  references?: string[];
}

interface ExperimentRecord {
  id: string;
  opportunityId: string;
  specId: string;
  proposalId?: string;
  mode: string;
  owner: string;
  hostRefs?: string[];
  status: string;
  summary?: string;
}

interface StateFile {
  events: unknown[];
  signals: unknown[];
  opportunities: unknown[];
  specs: SpecRecord[];
  experiments: ExperimentRecord[];
  decisions: unknown[];
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "directive" | "decision" | "status" | "message";
  text: string;
  ts: string;
}

interface QueuedMessageRecord {
  id: string;
  text: string;
  queuedAt: string;
}

interface ChatRunRecord {
  id: string;
  threadId: string | null;
  pid: number | null;
  repoPath: string;
  logPath: string;
  outputPath: string;
  prompt: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  transcriptStoredAt?: string;
}

interface SessionStateRecord {
  messages: SessionMessage[];
  threadId: string | null;
  runs: ChatRunRecord[];
  queuedMessages: QueuedMessageRecord[];
  memory: string;
}

interface TimelineEntry {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "message" | "tool" | "status";
  text: string;
  ts: string;
}

interface TargetCatalogTarget {
  id: string;
  label?: string;
  repoPath: string;
  [key: string]: unknown;
}

interface TargetCatalogFile {
  targets: TargetCatalogTarget[];
}

const loopConfig = buildLoopConfig();
const projectLabel = loopConfig.project?.label ?? loopConfig.projectId;
const statePath = loopConfig.paths.stateFile;
const approvalStatePath = loopConfig.paths.approvalStateFile;
const workerPidPath = loopConfig.paths.workerPidPath;
const targetsPath = loopConfig.paths.targetsFile;
const sessionMessagesPath = loopConfig.paths.sessionMessagesFile;
const sessionRuntimeDir = join(dirname(sessionMessagesPath), "chat-runs");
const dashboardHost = process.env.PM_LOOP_DASHBOARD_HOST ?? "127.0.0.1";
const dashboardPort = Number(process.env.PM_LOOP_DASHBOARD_PORT ?? String(loopConfig.project?.dashboardPort ?? 4311));
const chatCodexCommand = process.env.PM_LOOP_CHAT_CODEX_COMMAND ?? process.env.PM_LOOP_CODEX_COMMAND ?? "codex";
const chatModel = process.env.PM_LOOP_CHAT_MODEL ?? "gpt-5.4";
const chatReasoningEffort = process.env.PM_LOOP_CHAT_REASONING ?? "high";
const approvalGate = new JsonFileApprovalGate({ filePath: approvalStatePath });
const targetRegistry = new LocalTargetRegistry({ filePath: targetsPath });

const json = (value: unknown): string => JSON.stringify(value);

const readText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const readState = async (): Promise<StateFile> => {
  const raw = await readText(statePath);
  if (!raw) {
    return {
      events: [],
      signals: [],
      opportunities: [],
      specs: [],
      experiments: [],
      decisions: []
    };
  }
  return JSON.parse(raw) as StateFile;
};

const readFileMtime = async (filePath: string): Promise<string | null> => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.mtime.toISOString();
  } catch {
    return null;
  }
};

const readWorkerPid = async (): Promise<number | null> => {
  const raw = (await readText(workerPidPath)).trim();
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
};

const isProcessAlive = (pid: number | null): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const proposalSortWeight = (status: string): number => {
  if (status === "queued") return 0;
  if (status === "approved") return 1;
  if (status === "deferred") return 2;
  if (status === "rejected") return 3;
  return 4;
};

const isActiveExperiment = (status: string): boolean => status === "draft" || status === "running";

const defaultSessionState = (): SessionStateRecord => ({
  messages: [],
  threadId: null,
  runs: [],
  queuedMessages: [],
  memory: ""
});

const readSessionState = async (): Promise<SessionStateRecord> => {
  const raw = await readText(sessionMessagesPath);
  if (!raw) return defaultSessionState();
  try {
    const parsed = JSON.parse(raw) as
      | {
          messages?: SessionMessage[];
          threadId?: string | null;
          runs?: ChatRunRecord[];
          queuedMessages?: QueuedMessageRecord[];
          memory?: string;
        }
      | SessionMessage[];
    if (Array.isArray(parsed)) {
      return {
        ...defaultSessionState(),
        messages: parsed
      };
    }
    return {
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      queuedMessages: Array.isArray(parsed.queuedMessages) ? parsed.queuedMessages : [],
      memory: typeof parsed.memory === "string" ? parsed.memory : ""
    };
  } catch {
    return defaultSessionState();
  }
};

const writeSessionState = async (state: SessionStateRecord): Promise<void> => {
  await mkdir(dirname(sessionMessagesPath), { recursive: true });
  await writeFile(sessionMessagesPath, JSON.stringify(state, null, 2), "utf8");
};

const appendSessionMessage = async (input: {
  role: SessionMessage["role"];
  kind: SessionMessage["kind"];
  text: string;
}): Promise<SessionMessage> => {
  const sessionState = await readSessionState();
  const message: SessionMessage = {
    id: `msg:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    role: input.role,
    kind: input.kind,
    text: input.text,
    ts: new Date().toISOString()
  };
  sessionState.messages.push(message);
  await writeSessionState(sessionState);
  return message;
};

const readTargetCatalog = async (): Promise<TargetCatalogFile> => {
  const raw = await readText(targetsPath);
  if (!raw) return { targets: [] };
  try {
    return JSON.parse(raw) as TargetCatalogFile;
  } catch {
    return { targets: [] };
  }
};

const writeTargetCatalog = async (catalog: TargetCatalogFile): Promise<void> => {
  await writeFile(targetsPath, JSON.stringify(catalog, null, 2), "utf8");
};

const updateCurrentTargetPath = async (repoPath: string): Promise<TargetCatalogTarget | null> => {
  const targetId = loopConfig.project?.targetId;
  if (!targetId) return null;
  const catalog = await readTargetCatalog();
  let updated: TargetCatalogTarget | null = null;
  catalog.targets = catalog.targets.map((target) => {
    if (target.id !== targetId) return target;
    updated = {
      ...target,
      repoPath
    };
    return updated;
  });
  if (!updated) return null;
  await writeTargetCatalog(catalog);
  return updated;
};

const updateSessionMemory = async (memory: string): Promise<SessionStateRecord> => {
  const sessionState = await readSessionState();
  const nextState: SessionStateRecord = {
    ...sessionState,
    memory
  };
  await writeSessionState(nextState);
  return nextState;
};

const getActiveChatRun = (sessionState: SessionStateRecord): ChatRunRecord | null =>
  sessionState.runs.find((run) => run.status === "running" && isProcessAlive(run.pid)) ?? null;

const trimForTimeline = (value: string, maxLength = 1800): string => {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n…`;
};

const buildChatPrompt = (input: {
  projectLabel: string;
  repoPath: string;
  userText: string;
  memory: string;
}): string =>
  [
    `Product session: ${input.projectLabel}`,
    `Current target path: ${input.repoPath}`,
    input.memory ? `Memory:\n${input.memory}` : null,
    input.memory ? "Treat memory as durable context unless the user clearly changes it." : null,
    "Respond inside this ongoing product conversation.",
    "If the user asks for product or code changes, inspect and edit the repository directly.",
    "Keep the reply concise and practical.",
    "",
    input.userText
  ].join("\n");

const extractJsonPayload = (line: string): Record<string, unknown> | null => {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(line.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const parseChatRunTimeline = async (run: ChatRunRecord): Promise<{
  threadId: string | null;
  completed: boolean;
  entries: TimelineEntry[];
}> => {
  const raw = await readText(run.logPath);
  if (!raw) {
    return {
      threadId: run.threadId,
      completed: false,
      entries:
        run.status === "running"
          ? [
              {
                id: `${run.id}:pending`,
                role: "assistant",
                kind: "status",
                text: "thinking",
                ts: run.createdAt
              }
            ]
          : []
    };
  }

  let threadId = run.threadId;
  let completed = false;
  const entries: TimelineEntry[] = [];
  let sawProgress = false;
  let sequence = 0;

  for (const line of raw.split("\n")) {
    const payload = extractJsonPayload(line.trim());
    if (!payload || typeof payload.type !== "string") continue;
    const type = payload.type;

    if (type === "thread.started" && typeof payload.thread_id === "string") {
      threadId = payload.thread_id;
      continue;
    }

    if (type === "turn.completed") {
      completed = true;
      continue;
    }

    if (type === "turn.started") {
      entries.push({
        id: `${run.id}:turn:${sequence++}`,
        role: "assistant",
        kind: "status",
        text: "thinking",
        ts: run.createdAt
      });
      continue;
    }

    if (!type.startsWith("item.")) continue;
    const item = payload.item;
    if (!item || typeof item !== "object") continue;
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "agent_message" && typeof item.text === "string") {
      sawProgress = true;
      entries.push({
        id: `${run.id}:agent:${sequence++}`,
        role: "assistant",
        kind: "message",
        text: item.text,
        ts: run.createdAt
      });
      continue;
    }

    if (itemType === "command_execution" && typeof item.command === "string") {
      sawProgress = true;
      const output = typeof item.aggregated_output === "string" ? trimForTimeline(item.aggregated_output) : "";
      const text = output ? `${item.command}\n${output}` : item.command;
      entries.push({
        id: `${run.id}:tool:${sequence++}`,
        role: "assistant",
        kind: "tool",
        text,
        ts: run.createdAt
      });
      continue;
    }
  }

  if (!completed && run.status === "running" && !sawProgress) {
    entries.push({
      id: `${run.id}:waiting`,
      role: "assistant",
      kind: "status",
      text: "thinking",
      ts: run.createdAt
    });
  }

  return { threadId, completed, entries };
};

const reconcileSessionState = async (): Promise<{
  sessionState: SessionStateRecord;
  runTimeline: TimelineEntry[];
}> => {
  const current = await readSessionState();
  let nextThreadId = current.threadId;
  let dirty = false;
  let nextMessages = current.messages;
  const runTimeline: TimelineEntry[] = [];
  const nextRuns: ChatRunRecord[] = [];

  for (const run of current.runs) {
    const parsed = await parseChatRunTimeline(run);
    runTimeline.push(...parsed.entries);

    let nextRun = run;
    if (parsed.threadId && parsed.threadId !== run.threadId) {
      nextRun = { ...nextRun, threadId: parsed.threadId };
      dirty = true;
    }
    if (!nextThreadId && parsed.threadId) {
      nextThreadId = parsed.threadId;
      dirty = true;
    }
    if (run.status === "running") {
      const nextStatus = parsed.completed ? "completed" : isProcessAlive(run.pid) ? "running" : "failed";
      if (nextStatus !== run.status) {
        nextRun = {
          ...nextRun,
          status: nextStatus,
          completedAt: new Date().toISOString()
        };
        dirty = true;
      }
    }
    const nextRunIsFinal = nextRun.status === "completed" || nextRun.status === "failed";
    if (nextRunIsFinal && !nextRun.transcriptStoredAt) {
      const persistedAssistantMessages = parsed.entries
        .filter((entry) => entry.role === "assistant" && entry.kind === "message" && entry.text.trim())
        .map((entry, index) => ({
          id: `${run.id}:persisted:${index}`,
          role: "assistant" as const,
          kind: "message" as const,
          text: entry.text,
          ts: entry.ts
        }));
      if (persistedAssistantMessages.length > 0) {
        nextMessages = [...nextMessages, ...persistedAssistantMessages];
      }
      nextRun = {
        ...nextRun,
        transcriptStoredAt: new Date().toISOString()
      };
      dirty = true;
    }
    nextRuns.push(nextRun);
  }

  const nextState: SessionStateRecord = dirty
    ? {
        messages: nextMessages,
        threadId: nextThreadId,
        runs: nextRuns,
        queuedMessages: current.queuedMessages,
        memory: current.memory
      }
    : current;

  if (dirty) {
    await writeSessionState(nextState);
  }

  return {
    sessionState: nextState,
    runTimeline
  };
};

const launchChatRun = async (input: {
  sessionState: SessionStateRecord;
  userText: string;
  target: ProjectTarget;
  queuedMessageId?: string | null;
}): Promise<{ sessionState: SessionStateRecord; message: SessionMessage; run: ChatRunRecord }> => {
  const activeRun = getActiveChatRun(input.sessionState);
  if (activeRun) {
    throw new Error("Agent is still responding.");
  }

  const createdAt = new Date().toISOString();
  const message: SessionMessage = {
    id: `msg:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    kind: "directive",
    text: input.userText,
    ts: createdAt
  };

  const runId = `chat:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(sessionRuntimeDir, { recursive: true });
  const logPath = join(sessionRuntimeDir, `${runId}.jsonl`);
  const outputPath = join(sessionRuntimeDir, `${runId}.last.txt`);
  const prompt = buildChatPrompt({
    projectLabel,
    repoPath: input.target.repoPath,
    userText: input.userText,
    memory: input.sessionState.memory
  });

  const args = input.sessionState.threadId
    ? [
        "exec",
        "resume",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        chatModel,
        "-c",
        `model_reasoning_effort=${chatReasoningEffort}`,
        "-o",
        outputPath,
        input.sessionState.threadId,
        prompt
      ]
    : [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-C",
        input.target.repoPath,
        "-m",
        chatModel,
        "-c",
        `model_reasoning_effort=${chatReasoningEffort}`,
        "-o",
        outputPath,
        prompt
      ];

  const out = openSync(logPath, "a");
  const child = spawn(chatCodexCommand, args, {
    cwd: input.target.repoPath,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();

  const run: ChatRunRecord = {
    id: runId,
    threadId: input.sessionState.threadId,
    pid: child.pid ?? null,
    repoPath: input.target.repoPath,
    logPath,
    outputPath,
    prompt,
    status: "running",
    createdAt
  };

  const nextState: SessionStateRecord = {
    messages: [...input.sessionState.messages, message],
    threadId: input.sessionState.threadId,
    runs: [...input.sessionState.runs, run],
    queuedMessages: input.queuedMessageId
      ? input.sessionState.queuedMessages.filter((item) => item.id !== input.queuedMessageId)
      : input.sessionState.queuedMessages,
    memory: input.sessionState.memory
  };
  await writeSessionState(nextState);

  return { sessionState: nextState, message, run };
};

const submitChatMessage = async (input: {
  userText: string;
  target: ProjectTarget;
}): Promise<
  | { queued: false; message: SessionMessage; run: ChatRunRecord }
  | { queued: true; queuedMessage: QueuedMessageRecord }
> => {
  const sessionState = await readSessionState();
  if (getActiveChatRun(sessionState)) {
    const queuedMessage: QueuedMessageRecord = {
      id: `queue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      text: input.userText,
      queuedAt: new Date().toISOString()
    };
  const nextState: SessionStateRecord = {
      ...sessionState,
      queuedMessages: [...sessionState.queuedMessages, queuedMessage]
    };
    await writeSessionState(nextState);
    return { queued: true, queuedMessage };
  }

  const launched = await launchChatRun({
    sessionState,
    userText: input.userText,
    target: input.target
  });
  return {
    queued: false,
    message: launched.message,
    run: launched.run
  };
};

const ensureQueuedChatProgress = async (
  sessionState: SessionStateRecord,
  target: ProjectTarget | null
): Promise<{
  sessionState: SessionStateRecord;
  enqueuedRunTimeline: TimelineEntry[];
}> => {
  if (!target || getActiveChatRun(sessionState) || sessionState.queuedMessages.length === 0) {
    return {
      sessionState,
      enqueuedRunTimeline: []
    };
  }

  const nextQueued = sessionState.queuedMessages[0];
  if (!nextQueued) {
    return {
      sessionState,
      enqueuedRunTimeline: []
    };
  }

  const launched = await launchChatRun({
    sessionState,
    userText: nextQueued.text,
    target,
    queuedMessageId: nextQueued.id
  });
  const parsed = await parseChatRunTimeline(launched.run);
  return {
    sessionState: launched.sessionState,
    enqueuedRunTimeline: parsed.entries
  };
};

const buildOverview = async (): Promise<Record<string, unknown>> => {
  const [{ sessionState, runTimeline }, state, workerPid, stateUpdatedAt, proposals, targets] = await Promise.all([
    reconcileSessionState(),
    readState(),
    readWorkerPid(),
    readFileMtime(statePath),
    approvalGate.listProposals(),
    targetRegistry.listTargets()
  ]);

  const currentTarget = targets.find((target) => target.id === loopConfig.project?.targetId) ?? null;
  const queuedProgress = await ensureQueuedChatProgress(sessionState, currentTarget);
  const effectiveSessionState = queuedProgress.sessionState;
  const specByOpportunityId = new Map(state.specs.map((spec) => [spec.opportunityId, spec]));
  const targetById = new Map<string, ProjectTarget>(targets.map((target) => [target.id, target]));
  const activeRun = getActiveChatRun(effectiveSessionState);

  const needs = [...proposals]
    .filter((proposal) => proposal.status === "queued")
    .sort((a, b) => {
      const weightDelta = proposalSortWeight(a.status) - proposalSortWeight(b.status);
      if (weightDelta !== 0) return weightDelta;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    })
    .slice(0, 5)
    .map((proposal: ChangeProposal) => {
      const target = targetById.get(proposal.targetId);
      const spec = specByOpportunityId.get(proposal.opportunityId);
      return {
        id: proposal.id,
        title: proposal.title,
        summary: proposal.summary,
        rationale: proposal.rationale,
        createdAt: proposal.createdAt,
        changeType: proposal.changeType,
        riskLevel: proposal.riskLevel,
        targetLabel: target?.label ?? proposal.targetId,
        requestedActions: proposal.requestedActions,
        desiredBehavior: spec?.desiredBehavior ?? null
      };
    });

  const sessionTimeline: TimelineEntry[] = effectiveSessionState.messages
    .filter((message) => message.role !== "system")
    .slice(-80)
    .map((message) => ({
      id: message.id,
      role: message.role,
      kind: "message",
      text: message.text,
      ts: message.ts
    }));

  const liveRunTimeline: TimelineEntry[] = activeRun
    ? runTimeline.filter((entry) => entry.id.startsWith(`${activeRun.id}:`))
    : [];

  const timeline = [...sessionTimeline, ...liveRunTimeline, ...queuedProgress.enqueuedRunTimeline].slice(-120);

  return {
    projectLabel,
    workerAlive: isProcessAlive(workerPid),
    stateUpdatedAt,
    settings: {
      targetId: currentTarget?.id ?? loopConfig.project?.targetId ?? null,
      targetLabel: currentTarget?.label ?? loopConfig.project?.targetId ?? null,
      repoPath: currentTarget?.repoPath ?? ""
    },
    memory: effectiveSessionState.memory,
    needs,
    chatRunning: Boolean(getActiveChatRun(effectiveSessionState)),
    queuedMessages: effectiveSessionState.queuedMessages,
    timeline
  };
};

const dashboardHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Session</title>
    <style>
      :root {
        --bg: #f6f3ec;
        --panel: rgba(255,255,255,0.72);
        --panel-strong: rgba(255,255,255,0.92);
        --line: rgba(25,29,26,0.1);
        --text: #1a221e;
        --muted: #727872;
        --accent: #0f6c5c;
        --accent-soft: rgba(15,108,92,0.08);
        --danger: #a34d36;
        --danger-soft: rgba(163,77,54,0.08);
        --shadow: 0 10px 30px rgba(22, 26, 23, 0.06);
        --chat-gutter: 22px;
        --border: rgba(25,29,26,0.1);
        --border-strong: rgba(25,29,26,0.18);
        --text-secondary: #6f766f;
        --text-muted: #8a9189;
        --bg-secondary: rgba(255,255,255,0.6);
        --bg-tertiary: rgba(255,255,255,0.78);
        --user-bubble: rgba(15,108,92,0.1);
        --focus-border: rgba(15,108,92,0.35);
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        height: 100%;
        background:
          radial-gradient(circle at top left, rgba(255,255,255,0.8), transparent 38%),
          linear-gradient(180deg, #f8f5ee 0%, #f1eee6 100%);
        color: var(--text);
        font-family: "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      }

      body {
        overflow: hidden;
      }

      button,
      input,
      textarea {
        font: inherit;
      }

      .app-shell {
        height: 100vh;
        display: grid;
        grid-template-columns: 340px minmax(0, 1fr);
      }

      .sidebar {
        min-width: 0;
        border-right: 1px solid var(--line);
        background: rgba(248, 245, 238, 0.8);
        backdrop-filter: blur(20px);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }

      .sidebar-top {
        padding: 18px 18px 14px;
        display: grid;
        gap: 12px;
        border-bottom: 1px solid var(--line);
      }

      .session-title {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .path-form {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
      }

      .memory-form {
        display: grid;
        gap: 10px;
      }

      .path-input,
      .composer-input,
      .memory-input {
        width: 100%;
        border: 1px solid var(--line);
        background: var(--panel-strong);
        color: var(--text);
        outline: none;
      }

      .path-input {
        height: 42px;
        padding: 0 13px;
        border-radius: 14px;
      }

      .memory-input {
        min-height: 88px;
        padding: 12px 13px;
        border-radius: 16px;
        resize: none;
        line-height: 1.6;
      }

      .button {
        height: 42px;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0 14px;
        background: transparent;
        color: var(--text);
        cursor: pointer;
      }

      .button:hover {
        background: rgba(255,255,255,0.4);
      }

      .button:disabled {
        opacity: 0.55;
        cursor: wait;
      }

      .button-primary {
        border-color: rgba(15,108,92,0.18);
        background: var(--accent-soft);
      }

      .button-danger {
        border-color: rgba(163,77,54,0.18);
        background: var(--danger-soft);
      }

      .needs {
        overflow: auto;
        padding: 0 18px 24px;
      }

      .need-item {
        padding: 16px 0;
        border-bottom: 1px solid var(--line);
        display: grid;
        gap: 8px;
      }

      .need-item:first-child {
        padding-top: 18px;
      }

      .need-title,
      .need-copy,
      .empty,
      .message-copy,
      .message-meta,
      .message-label {
        margin: 0;
      }

      .need-title {
        font-size: 15px;
        line-height: 1.45;
        font-weight: 600;
      }

      .need-copy {
        font-size: 14px;
        line-height: 1.68;
        color: var(--muted);
        white-space: pre-wrap;
      }

      .need-actions {
        display: flex;
        gap: 8px;
        padding-top: 4px;
      }

      .empty {
        padding: 20px 0;
        color: var(--muted);
        font-size: 14px;
      }

      .queued-panel {
        max-width: 860px;
        margin: 0 auto;
        padding: 0 24px 12px;
        display: grid;
        gap: 8px;
      }

      .queued-panel[hidden] {
        display: none;
      }

      .queued-item {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.55);
        display: grid;
        gap: 4px;
      }

      .queued-meta {
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .chat-shell {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }

      .chat-head {
        height: 56px;
        display: flex;
        align-items: center;
        padding: 0 var(--chat-gutter);
        border-bottom: 1px solid var(--border);
        background: rgba(248, 245, 238, 0.42);
        backdrop-filter: blur(20px);
      }

      .chat-head-title {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .chat-main {
        min-height: 0;
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto auto;
      }

      .messages {
        min-height: 0;
        overflow-y: auto;
        padding: 20px var(--chat-gutter);
        -webkit-overflow-scrolling: touch;
      }

      .messages-inner {
        width: 100%;
        min-width: 0;
        max-width: 100%;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100%;
        padding: 40px 20px;
        color: var(--text-secondary);
        text-align: center;
      }

      .empty-state h2 {
        margin: 0;
        font-size: 22px;
        color: var(--text);
        font-weight: 600;
      }

      .msg-user {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 16px;
      }

      .msg-user-stack {
        display: grid;
        justify-items: end;
        gap: 6px;
        max-width: 80%;
      }

      .msg-user-bubble {
        background: var(--user-bubble);
        border-radius: 18px;
        border-bottom-right-radius: 5px;
        padding: 10px 16px;
        font-size: 15px;
        line-height: 1.58;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .msg-assistant,
      .msg-status {
        margin-bottom: 20px;
        font-size: 15px;
        line-height: 1.68;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .msg-assistant-copy {
        display: grid;
        gap: 8px;
      }

      .msg-timestamp {
        margin-top: 8px;
        font-size: 11px;
        line-height: 1.3;
        color: var(--text-secondary);
        opacity: 0.84;
        font-variant-numeric: tabular-nums;
      }

      .msg-user-time {
        text-align: right;
      }

      .assistant-sidecar-panel {
        margin: 0;
        border-left: 2px solid var(--border);
      }

      .assistant-sidecar-panel details {
        display: block;
      }

      .assistant-sidecar-summary {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        list-style: none;
        user-select: none;
      }

      .assistant-sidecar-summary::-webkit-details-marker {
        display: none;
      }

      .assistant-sidecar-summary::before {
        content: "▸";
        font-size: 11px;
        color: var(--text-muted);
        transform: translateY(-1px);
      }

      details[open] > .assistant-sidecar-summary::before {
        content: "▾";
      }

      .assistant-sidecar-body {
        padding: 2px 0 2px 10px;
      }

      .assistant-sidecar-meta {
        margin-bottom: 6px;
        font-size: 10px;
        line-height: 1.3;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-muted);
      }

      .assistant-sidecar-pre,
      .code-block,
      .tool-block {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "SF Mono", "JetBrains Mono", monospace;
        font-size: 12px;
        line-height: 1.62;
        color: var(--text-secondary);
        padding: 0;
        border: 0;
        background: transparent;
        overflow: auto;
      }

      .message-copy {
        font-size: 15px;
        line-height: 1.68;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .message-copy code {
        padding: 1px 6px;
        border-radius: 8px;
        background: rgba(26, 34, 30, 0.06);
        font-family: "SF Mono", "JetBrains Mono", monospace;
        font-size: 12px;
      }

      .queued-panel {
        display: none;
        margin: 0 var(--chat-gutter) 10px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--bg-secondary);
      }

      .queued-panel.visible {
        display: block;
      }

      .queued-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .queued-panel-title {
        font-weight: 600;
        color: var(--text);
      }

      .queued-panel-note {
        color: var(--text-muted);
      }

      .queued-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .queued-item {
        display: grid;
        gap: 4px;
      }

      .queued-meta {
        font-size: 11px;
        color: var(--text-muted);
      }

      .input-area {
        flex-shrink: 0;
        padding: 0 var(--chat-gutter) 10px;
        background: transparent;
        border-top: 1px solid var(--border);
      }

      .input-wrapper {
        background: color-mix(in srgb, var(--bg) 94%, transparent);
        border: 1px solid var(--border-strong);
        border-radius: 12px;
        overflow: hidden;
        transition: border-color 0.15s;
      }

      .input-wrapper:focus-within {
        border-color: var(--focus-border);
      }

      .input-area.is-pending-send .input-wrapper {
        background: var(--bg-secondary);
      }

      .input-area.is-pending-send .input-row {
        opacity: 0.72;
      }

      .input-row {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 8px 10px 8px 14px;
      }

      .composer-input {
        flex: 1;
        min-height: calc(1.55em * 3);
        max-height: calc(1.55em * 10);
        padding: 3px 0;
        border: none;
        background: transparent;
        color: var(--text);
        font-size: 15px;
        line-height: 1.55;
        resize: none;
        overflow-y: auto;
      }

      .composer-input:focus,
      .path-input:focus,
      .memory-input:focus {
        outline: none;
      }

      .send-btn {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        border: none;
        background: var(--text);
        color: var(--bg);
        font-size: 15px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .send-btn:disabled {
        opacity: 0.25;
        cursor: not-allowed;
      }

      .composer-pending-state {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 0 14px 10px;
        color: var(--text-muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .composer-pending-state.visible {
        display: flex;
      }

      .composer-pending-state::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--accent);
        opacity: 0.8;
        flex-shrink: 0;
      }

      @media (max-width: 980px) {
        .app-shell {
          grid-template-columns: 1fr;
          grid-template-rows: 300px minmax(0, 1fr);
        }

        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--line);
        }
      }

      @media (max-width: 720px) {
        .sidebar-top,
        .needs,
        .chat-head,
        .messages,
        .queued-panel,
        .composer {
          padding-left: 14px;
          padding-right: 14px;
        }

        .path-form {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-top">
          <p class="session-title" id="projectTitle">Session</p>
          <form id="settingsForm" class="path-form">
            <input class="path-input" id="repoPathInput" name="repoPath" type="text" placeholder="/absolute/path" />
            <button class="button" type="submit">保存路径</button>
          </form>
          <form id="memoryForm" class="memory-form">
            <textarea class="memory-input" id="memoryInput" name="memory" placeholder="记忆"></textarea>
            <div>
              <button class="button" id="memorySaveBtn" type="submit">保存记忆</button>
            </div>
          </form>
        </div>
        <div class="needs" id="needList"></div>
      </aside>

      <section class="chat-shell">
        <div class="chat-head">
          <p class="chat-head-title" id="chatTitle">Session</p>
        </div>
        <div class="chat-main">
          <div class="messages" id="messages">
            <div class="messages-inner" id="messagesInner">
              <div class="empty-state" id="emptyState">
                <h2>这是一个会话</h2>
              </div>
            </div>
          </div>
          <div class="queued-panel" id="queuedPanel"></div>
          <form class="input-area" id="composerForm">
            <div class="input-wrapper">
              <div class="input-row">
                <textarea class="composer-input" id="msgInput" name="text" placeholder="输入内容"></textarea>
                <button class="send-btn" id="sendBtn" type="submit">➜</button>
              </div>
              <div class="composer-pending-state" id="composerPendingState" aria-live="polite"></div>
            </div>
          </form>
        </div>
      </section>
    </div>

    <script>
      const escapeHtml = (value) => String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

      const formatTime = (value) => {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(date);
      };

      let actionInFlight = false;
      const composerInput = document.getElementById("msgInput");
      const sendButton = document.getElementById("sendBtn");
      const composerPendingState = document.getElementById("composerPendingState");
      const queuedPanel = document.getElementById("queuedPanel");
      const messagesContainer = document.getElementById("messages");
      const messagesInner = document.getElementById("messagesInner");
      const memoryInput = document.getElementById("memoryInput");
      const memorySaveButton = document.getElementById("memorySaveBtn");
      const inputArea = document.getElementById("composerForm");
      const draftStorageKey = "pm-dashboard-draft";
      let shouldStickToBottom = true;
      let lastTimelineFingerprint = "";
      let latestOverview = null;

      const readDraft = () => window.localStorage.getItem(draftStorageKey) || "";
      const writeDraft = (value) => {
        if (value) {
          window.localStorage.setItem(draftStorageKey, value);
          return;
        }
        window.localStorage.removeItem(draftStorageKey);
      };

      const isNearBottom = () => {
        if (!(messagesContainer instanceof HTMLElement)) return true;
        return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 48;
      };

      const backtickChar = String.fromCharCode(96);
      const newlineChar = String.fromCharCode(10);
      const inlineCodePattern = new RegExp(
        backtickChar + "([^" + backtickChar + "\\\\n]+)" + backtickChar,
        "g"
      );
      const fencePattern = new RegExp(
        backtickChar + backtickChar + backtickChar + "([a-zA-Z0-9_-]*)\\\\n?([\\\\s\\\\S]*?)" + backtickChar + backtickChar + backtickChar,
        "g"
      );

      const renderInlineText = (value) =>
        escapeHtml(value)
          .replace(inlineCodePattern, "<code>$1</code>")
          .split(newlineChar)
          .join("<br />");

      const renderRichText = (value, kind) => {
        const source = String(value ?? "");
        if (!source) return "";
        if (kind === "tool") {
          return '<pre class="tool-block"><code>' + escapeHtml(source) + '</code></pre>';
        }

        const segments = [];
        let lastIndex = 0;
        let match;
        while ((match = fencePattern.exec(source)) !== null) {
          const before = source.slice(lastIndex, match.index);
          if (before.trim()) {
            segments.push('<div class="message-copy">' + renderInlineText(before) + '</div>');
          }
          segments.push('<pre class="code-block"><code>' + escapeHtml(match[2] || "") + '</code></pre>');
          lastIndex = match.index + match[0].length;
        }
        const tail = source.slice(lastIndex);
        if (tail.trim() || segments.length === 0) {
          segments.push('<div class="message-copy">' + renderInlineText(tail || source) + '</div>');
        }
        return segments.join("");
      };

      const autoResizeComposer = () => {
        if (!(composerInput instanceof HTMLTextAreaElement)) return;
        composerInput.style.height = "0px";
        composerInput.style.height = Math.min(composerInput.scrollHeight, 240) + "px";
      };

      const sendDecision = async (proposalId, outcome) => {
        if (actionInFlight) return;
        actionInFlight = true;
        try {
          const response = await fetch("/api/proposals/" + encodeURIComponent(proposalId) + "/decision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ outcome })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({ error: "Request failed" }));
            throw new Error(payload.error || "Request failed");
          }
          await refresh();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Unexpected error");
        } finally {
          actionInFlight = false;
          renderComposer(latestOverview || {});
        }
      };

      const sendDirective = async (text) => {
        if (actionInFlight) return;
        actionInFlight = true;
        try {
          shouldStickToBottom = true;
          const response = await fetch("/api/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({ error: "Request failed" }));
            throw new Error(payload.error || "Request failed");
          }
          writeDraft("");
          await refresh();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Unexpected error");
        } finally {
          actionInFlight = false;
          renderComposer(latestOverview || {});
        }
      };

      const saveRepoPath = async (repoPath) => {
        if (actionInFlight) return;
        actionInFlight = true;
        try {
          const response = await fetch("/api/settings/target-path", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repoPath })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({ error: "Request failed" }));
            throw new Error(payload.error || "Request failed");
          }
          await refresh();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Unexpected error");
        } finally {
          actionInFlight = false;
          renderComposer(latestOverview || {});
        }
      };

      const saveMemory = async (memory) => {
        if (actionInFlight) return;
        actionInFlight = true;
        try {
          const response = await fetch("/api/memory", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ memory })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({ error: "Request failed" }));
            throw new Error(payload.error || "Request failed");
          }
          await refresh();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Unexpected error");
        } finally {
          actionInFlight = false;
          renderComposer(latestOverview || {});
          renderMemory(latestOverview || {});
        }
      };

      const renderHeader = (overview) => {
        const title = overview.projectLabel || "Session";
        document.getElementById("projectTitle").textContent = title;
        document.getElementById("chatTitle").textContent = title;
        document.title = title;
      };

      const renderSettings = (overview) => {
        const input = document.getElementById("repoPathInput");
        if (!(input instanceof HTMLInputElement)) return;
        if (document.activeElement !== input) {
          input.value = overview.settings?.repoPath || "";
        }
      };

      const renderMemory = (overview) => {
        if (memoryInput instanceof HTMLTextAreaElement && document.activeElement !== memoryInput) {
          memoryInput.value = overview.memory || "";
        }
        if (memoryInput instanceof HTMLTextAreaElement) {
          memoryInput.disabled = actionInFlight;
        }
        if (memorySaveButton instanceof HTMLButtonElement) {
          memorySaveButton.disabled = actionInFlight;
        }
      };

      const renderNeeds = (overview) => {
        const needs = overview.needs || [];
        const container = document.getElementById("needList");
        container.innerHTML = needs.length
          ? needs.map((need) => {
              const actions = (need.requestedActions || [])
                .slice(0, 4)
                .join(" / ");
              const copy = [
                need.summary,
                need.rationale,
                need.desiredBehavior,
                actions
              ].filter(Boolean);
              return [
                '<article class="need-item">',
                '<p class="need-title">' + escapeHtml(need.title) + '</p>',
                copy.map((line) => '<p class="need-copy">' + escapeHtml(line) + '</p>').join(""),
                '<div class="need-actions">',
                '<button class="button button-primary need-action" type="button" data-proposal-id="' + escapeHtml(need.id) + '" data-outcome="approved">确认</button>',
                '<button class="button button-danger need-action" type="button" data-proposal-id="' + escapeHtml(need.id) + '" data-outcome="rejected">忽略</button>',
                '</div>',
                '</article>'
              ].join("");
            }).join("")
          : '<p class="empty">暂无需求</p>';
      };

      const renderQueuedMessages = (overview) => {
        if (!(queuedPanel instanceof HTMLElement)) return;
        const items = overview.queuedMessages || [];
        if (!items.length) {
          queuedPanel.classList.remove("visible");
          queuedPanel.innerHTML = "";
          return;
        }

        queuedPanel.classList.add("visible");
        queuedPanel.innerHTML = [
          '<div class="queued-panel-header">',
          '<div class="queued-panel-title">队列</div>',
          '<div class="queued-panel-note">' + escapeHtml(String(items.length)) + '</div>',
          '</div>',
          '<div class="queued-list">',
          items.slice(0, 3).map((item) => [
            '<div class="queued-item">',
            '<div class="queued-meta">' + escapeHtml(formatTime(item.queuedAt)) + '</div>',
            '<div class="need-copy">' + escapeHtml(item.text) + '</div>',
            '</div>'
          ].join("")).join(""),
          '</div>'
        ].join("");
      };

      const renderTimeline = (overview) => {
        const timeline = overview.timeline || [];
        const fingerprint = JSON.stringify(timeline.map((entry) => [entry.id, entry.kind, entry.text]));
        if (fingerprint === lastTimelineFingerprint) {
          return;
        }
        lastTimelineFingerprint = fingerprint;
        const shouldScroll = shouldStickToBottom || isNearBottom();
        const items = timeline.map((entry) => {
          if (entry.role === "user") {
            return [
              '<div class="msg-user">',
              '<div class="msg-user-stack">',
              '<div class="msg-user-bubble">' + renderRichText(entry.text, "message") + '</div>',
              (entry.ts ? '<div class="msg-timestamp msg-user-time">' + escapeHtml(formatTime(entry.ts)) + '</div>' : ''),
              '</div>',
              '</div>'
            ].join("");
          }

          if (entry.kind === "tool" || entry.kind === "status") {
            const summaryText = entry.kind === "tool"
              ? (() => {
                  const firstLine = String(entry.text || "").split("\\n")[0] || "tool";
                  return firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
                })()
              : entry.kind;
            return [
              '<div class="' + (entry.kind === "status" ? 'msg-status' : 'msg-assistant') + '">',
              '<div class="assistant-sidecar-panel">',
              '<div class="assistant-sidecar-body">',
              entry.kind === "tool"
                ? [
                    '<details>',
                    '<summary class="assistant-sidecar-summary">',
                    '<span class="assistant-sidecar-meta">' + escapeHtml(summaryText) + '</span>',
                    '</summary>',
                    '<pre class="assistant-sidecar-pre">' + escapeHtml(entry.text) + '</pre>',
                    '</details>'
                  ].join("")
                : [
                    '<div class="assistant-sidecar-meta">' + escapeHtml(summaryText) + '</div>',
                    '<pre class="assistant-sidecar-pre">' + escapeHtml(entry.text) + '</pre>'
                  ].join(""),
              (entry.ts ? '<div class="msg-timestamp">' + escapeHtml(formatTime(entry.ts)) + '</div>' : ''),
              '</div>',
              '</div>',
              '</div>'
            ].join("");
          }

          return [
            '<div class="msg-assistant">',
            '<div class="msg-assistant-copy">' + renderRichText(entry.text, "message") + '</div>',
            (entry.ts ? '<div class="msg-timestamp">' + escapeHtml(formatTime(entry.ts)) + '</div>' : ''),
            '</div>'
          ].join("");
        });

        if (!(messagesInner instanceof HTMLElement)) return;
        messagesInner.innerHTML = items.length
          ? items.join("")
          : '<div class="empty-state"><h2>这是一个会话</h2></div>';
        if (shouldScroll && messagesContainer instanceof HTMLElement) {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      };

      const renderComposer = (overview) => {
        if (composerInput instanceof HTMLTextAreaElement) {
          composerInput.disabled = actionInFlight;
          composerInput.placeholder = overview.chatRunning ? "继续说，消息会排队" : "输入内容";
        }
        if (sendButton instanceof HTMLButtonElement) {
          sendButton.disabled = actionInFlight;
          sendButton.textContent = "➜";
        }
        if (inputArea instanceof HTMLElement) {
          inputArea.classList.toggle("is-pending-send", actionInFlight);
        }
        if (composerPendingState instanceof HTMLElement) {
          const queueCount = Array.isArray(overview.queuedMessages) ? overview.queuedMessages.length : 0;
          if (actionInFlight) {
            composerPendingState.textContent = "发送中";
            composerPendingState.classList.add("visible");
          } else if (queueCount > 0) {
            composerPendingState.textContent = "队列 " + queueCount;
            composerPendingState.classList.add("visible");
          } else if (overview.chatRunning) {
            composerPendingState.textContent = "Agent 正在回复";
            composerPendingState.classList.add("visible");
          } else {
            composerPendingState.textContent = "";
            composerPendingState.classList.remove("visible");
          }
        }
      };

      const refresh = async () => {
        const response = await fetch("/api/overview", { cache: "no-store" });
        const overview = await response.json();
        latestOverview = overview;
        renderHeader(overview);
        renderSettings(overview);
        renderMemory(overview);
        renderNeeds(overview);
        renderQueuedMessages(overview);
        renderTimeline(overview);
        renderComposer(overview);
      };

      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.closest(".need-action");
        if (!(action instanceof HTMLButtonElement)) return;
        const proposalId = action.dataset.proposalId;
        const outcome = action.dataset.outcome;
        if (!proposalId) return;
        if (outcome !== "approved" && outcome !== "rejected") return;
        sendDecision(proposalId, outcome);
      });

      document.addEventListener("submit", (event) => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;

        if (form.id === "settingsForm") {
          event.preventDefault();
          const formData = new FormData(form);
          const repoPath = String(formData.get("repoPath") || "").trim();
          if (!repoPath) {
            window.alert("请输入路径。");
            return;
          }
          saveRepoPath(repoPath);
          return;
        }

        if (form.id === "composerForm") {
          event.preventDefault();
          const formData = new FormData(form);
          const text = String(formData.get("text") || "").trim();
          if (!text) return;
          sendDirective(text).then(() => {
            form.reset();
            autoResizeComposer();
          });
        }

        if (form.id === "memoryForm") {
          event.preventDefault();
          const formData = new FormData(form);
          const memory = String(formData.get("memory") || "");
          saveMemory(memory);
        }
      });

      if (composerInput instanceof HTMLTextAreaElement) {
        composerInput.value = readDraft();
        composerInput.addEventListener("input", autoResizeComposer);
        composerInput.addEventListener("input", () => {
          writeDraft(composerInput.value);
        });
        composerInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            const form = composerInput.closest("form");
            if (form instanceof HTMLFormElement) {
              form.requestSubmit();
            }
          }
        });
        autoResizeComposer();
      }

      if (messagesContainer instanceof HTMLElement) {
        messagesContainer.addEventListener("scroll", () => {
          shouldStickToBottom = isNearBottom();
        });
      }

      refresh();
      setInterval(refresh, 2000);
    </script>
  </body>
</html>`;

const sendJson = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: json(body)
});

const sendHtml = (body: string) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body
});

const sendError = (status: number, message: string) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: json({ error: message })
});

const sendNotFound = () => ({
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "Not found"
});

const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${dashboardHost}:${dashboardPort}`);

  try {
    if (url.pathname === "/") {
      const response = sendHtml(dashboardHtml);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/api/overview") {
      const response = sendJson(await buildOverview());
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        const response = sendError(400, "Message text is required.");
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      const targets = await targetRegistry.listTargets();
      const currentTarget = targets.find((target) => target.id === loopConfig.project?.targetId);
      if (!currentTarget) {
        const response = sendError(404, "Current target not found.");
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      let result;
      try {
        result = await submitChatMessage({
          userText: text,
          target: currentTarget
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed.";
        const response = sendError(500, message);
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      const response = sendJson({ ok: true, ...result });
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/target-path") {
      const body = await readJsonBody(req);
      const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
      if (!repoPath) {
        const response = sendError(400, "Repo path is required.");
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      const target = await updateCurrentTargetPath(repoPath);
      if (!target) {
        const response = sendError(404, "Current target not found.");
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      const response = sendJson({ ok: true, target });
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/memory") {
      const body = await readJsonBody(req);
      const memory = typeof body.memory === "string" ? body.memory : "";
      const sessionState = await updateSessionMemory(memory);
      const response = sendJson({ ok: true, memory: sessionState.memory });
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    const decisionMatch = url.pathname.match(/^\/api\/proposals\/(.+)\/decision$/);
    if (req.method === "POST" && decisionMatch) {
      const body = await readJsonBody(req);
      const outcome = body.outcome;
      if (outcome !== "approved" && outcome !== "rejected") {
        const response = sendError(400, "Invalid approval outcome.");
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      const proposalId = decodeURIComponent(decisionMatch[1] ?? "");
      const proposals = await approvalGate.listProposals();
      const proposal = proposals.find((item) => item.id === proposalId);
      const approval = await approvalGate.recordApproval({
        proposalId,
        outcome: outcome as ApprovalOutcome,
        actor: "dashboard-ui"
      });
      await appendSessionMessage({
        role: "user",
        kind: "decision",
        text: `${outcome === "approved" ? "确认" : "忽略"} ${proposal?.title ?? proposalId}`
      });
      const response = sendJson({ ok: true, approval });
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const response = sendNotFound();
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(json({ error: message }));
  }
});

server.listen(dashboardPort, dashboardHost, () => {
  console.log(
    JSON.stringify(
      {
        app: "pm-loop-dashboard",
        host: dashboardHost,
        port: dashboardPort,
        url: `http://${dashboardHost}:${dashboardPort}`
      },
      null,
      2
    )
  );
});
