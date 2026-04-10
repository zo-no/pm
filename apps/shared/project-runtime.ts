import type { Event, EventSource } from "@pm-loop/core";
import { MelodySyncRuntimeEventSource } from "@pm-loop/adapter-melodysync";
import { readFile, stat } from "node:fs/promises";
import { buildProjectPaths, type LoopConfig } from "./config.js";

interface ProjectStateOpportunity {
  id: string;
  title: string;
  problem: string;
  priorityScore?: number;
  status: string;
}

interface ProjectStateExperiment {
  id: string;
  proposalId?: string;
  status: string;
  summary?: string;
}

interface ProjectStateFile {
  opportunities?: ProjectStateOpportunity[];
  experiments?: ProjectStateExperiment[];
}

interface SessionMessage {
  id: string;
  role: string;
  kind?: string;
  text: string;
  ts: string;
}

const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const mapProjectEvents = (
  projectId: string,
  underlyingSource: string,
  events: Event[]
): Event[] =>
  events.map((event) => ({
    ...event,
    source: projectId,
    tags: [...(event.tags ?? []), `underlying:${underlyingSource}`],
    payload: {
      ...(event.payload ?? {}),
      underlyingSource
    }
  }));

const readSessionMessages = async (filePath: string): Promise<SessionMessage[]> => {
  const payload = await readJsonFile<{ messages?: SessionMessage[] } | SessionMessage[]>(filePath);
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.messages) ? payload.messages : [];
};

const buildManualDirectiveEvents = async (loopConfig: LoopConfig, since: string): Promise<Event[]> => {
  const messages = await readSessionMessages(loopConfig.paths.sessionMessagesFile);
  return messages
    .filter((message) => message.role === "user" && (message.kind ?? "directive") === "directive")
    .filter((message) => message.ts >= since)
    .map((message) => ({
      id: `directive:${loopConfig.projectId}:${message.id}`,
      ts: message.ts,
      source: loopConfig.project?.sourceId ?? loopConfig.projectId,
      actor: "owner",
      type: "explicit_feedback" as const,
      subject: `${loopConfig.projectId}:manual-directive`,
      outcome: "neutral" as const,
      tags: ["manual-directive", loopConfig.projectId],
      payload: {
        kind: "manual-directive",
        note: message.text
      },
      hostRefs: {
        messageId: message.id,
        sessionMessagesFile: loopConfig.paths.sessionMessagesFile
      }
    }));
};

const buildPeerProjectEvents = async (loopConfig: LoopConfig, since: string): Promise<Event[]> => {
  const peerProjectIds = loopConfig.project?.peerProjectIds ?? [];
  if (peerProjectIds.length === 0) {
    return [];
  }

  const events: Event[] = [];
  for (const peerProjectId of peerProjectIds) {
    const peerPaths = buildProjectPaths(loopConfig.paths.instanceRoot, peerProjectId);
    const peerState = await readJsonFile<ProjectStateFile>(peerPaths.stateFile);

    let peerUpdatedAt = new Date().toISOString();
    try {
      peerUpdatedAt = (await stat(peerPaths.stateFile)).mtime.toISOString();
    } catch {
      peerUpdatedAt = new Date().toISOString();
    }
    if (peerUpdatedAt < since) {
      continue;
    }

    if (!peerState) {
      events.push({
        id: `peer:${loopConfig.projectId}:${peerProjectId}:bootstrap`,
        ts: peerUpdatedAt,
        source: loopConfig.project?.sourceId ?? loopConfig.projectId,
        actor: "system",
        type: "explicit_feedback",
        subject: `${peerProjectId}:bootstrap-review`,
        outcome: "unknown",
        tags: ["peer-project", peerProjectId, "bootstrap"],
        payload: {
          peerProjectId,
          kind: "bootstrap",
          note: `Review ${peerProjectId} and suggest the next iteration from the latest available context.`
        },
        hostRefs: {
          peerProjectId
        }
      });
      continue;
    }

    const topOpportunities = [...(peerState.opportunities ?? [])]
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
      .slice(0, 2);
    for (const opportunity of topOpportunities) {
      events.push({
        id: `peer:${loopConfig.projectId}:${peerProjectId}:opportunity:${opportunity.id}`,
        ts: peerUpdatedAt,
        source: loopConfig.project?.sourceId ?? loopConfig.projectId,
        actor: "system",
        type: "explicit_feedback",
        subject: `${peerProjectId}:${opportunity.title}`,
        outcome: "neutral",
        tags: ["peer-project", peerProjectId, "opportunity"],
        payload: {
          peerProjectId,
          kind: "opportunity",
          title: opportunity.title,
          problem: opportunity.problem,
          priorityScore: opportunity.priorityScore ?? 0,
          status: opportunity.status
        },
        hostRefs: {
          peerProjectId,
          stateFile: peerPaths.stateFile
        }
      });
    }

    const activeExperiments = (peerState.experiments ?? [])
      .filter((experiment) => experiment.status === "draft" || experiment.status === "running")
      .slice(0, 2);
    for (const experiment of activeExperiments) {
      events.push({
        id: `peer:${loopConfig.projectId}:${peerProjectId}:experiment:${experiment.id}`,
        ts: peerUpdatedAt,
        source: loopConfig.project?.sourceId ?? loopConfig.projectId,
        actor: "system",
        type: "tool_error",
        subject: `${peerProjectId}:${experiment.id}`,
        target: experiment.id,
        outcome: "unknown",
        tags: ["peer-project", peerProjectId, "experiment"],
        payload: {
          peerProjectId,
          kind: "experiment",
          summary: experiment.summary ?? "",
          status: experiment.status,
          proposalId: experiment.proposalId ?? ""
        },
        hostRefs: {
          peerProjectId,
          stateFile: peerPaths.stateFile
        }
      });
    }

    if (topOpportunities.length === 0 && activeExperiments.length === 0) {
      events.push({
        id: `peer:${loopConfig.projectId}:${peerProjectId}:bootstrap`,
        ts: peerUpdatedAt,
        source: loopConfig.project?.sourceId ?? loopConfig.projectId,
        actor: "system",
        type: "explicit_feedback",
        subject: `${peerProjectId}:bootstrap-review`,
        outcome: "unknown",
        tags: ["peer-project", peerProjectId, "bootstrap"],
        payload: {
          peerProjectId,
          kind: "bootstrap",
          note: `Peer project ${peerProjectId} has no loop output yet. Start with a first review proposal.`
        },
        hostRefs: {
          peerProjectId
        }
      });
    }
  }

  return events;
};

class LoopProjectEventSource implements EventSource {
  private readonly runtimeEventSource: EventSource | null;

  constructor(private readonly loopConfig: LoopConfig) {
    this.runtimeEventSource =
      this.loopConfig.project?.sourceType === "melodysync-runtime"
        ? new MelodySyncRuntimeEventSource({
            runtimeRoot: this.loopConfig.project.runtimeRoot
          })
        : null;
  }

  async fetchEvents(input: { since: string; cursor?: string }): Promise<{ events: Event[]; nextCursor?: string }> {
    const runtimeEvents = this.runtimeEventSource
      ? await this.runtimeEventSource.fetchEvents({ since: input.since, cursor: input.cursor })
      : { events: [] as Event[], nextCursor: undefined };
    const mappedRuntimeEvents = mapProjectEvents(
      this.loopConfig.project?.sourceId ?? this.loopConfig.projectId,
      this.loopConfig.project?.sourceType ?? "project",
      runtimeEvents.events
    );
    const peerEvents = await buildPeerProjectEvents(this.loopConfig, input.since);
    const manualDirectiveEvents = await buildManualDirectiveEvents(this.loopConfig, input.since);
    const deduped = new Map<string, Event>();
    for (const event of [...mappedRuntimeEvents, ...peerEvents, ...manualDirectiveEvents]) {
      deduped.set(event.id, event);
    }
    return {
      events: [...deduped.values()].sort((a, b) => a.ts.localeCompare(b.ts)),
      nextCursor: runtimeEvents.nextCursor
    };
  }
}

export const createProjectEventSource = (loopConfig: LoopConfig): EventSource =>
  new LoopProjectEventSource(loopConfig);
