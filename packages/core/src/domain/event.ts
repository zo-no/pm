export type EventActor = "user" | "agent" | "system" | "adapter";

export type EventType =
  | "user_intent"
  | "agent_plan"
  | "tool_call"
  | "tool_error"
  | "user_correction"
  | "branch_spawned"
  | "task_completed"
  | "task_abandoned"
  | "explicit_feedback";

export type EventOutcome = "success" | "failure" | "neutral" | "unknown";

export interface Event {
  id: string;
  ts: string;
  source: string;
  actor: EventActor;
  type: EventType;
  subject?: string;
  sessionId?: string;
  runId?: string;
  target?: string;
  outcome: EventOutcome;
  durationMs?: number;
  retryCount?: number;
  tags: string[];
  payload: Record<string, unknown>;
  hostRefs?: Record<string, string>;
}

export interface EventWindow {
  since: string;
  until?: string;
  cursor?: string;
}
