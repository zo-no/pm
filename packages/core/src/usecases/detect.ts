import type { Signal } from "../domain/signal.js";
import type { DetectionThresholds } from "../policies/thresholds.js";
import { DEFAULT_THRESHOLDS } from "../policies/thresholds.js";
import type { StateStore } from "../ports/state-store.js";

const signalTypeFromEventType = (type: string): Signal["signalType"] | null => {
  switch (type) {
    case "user_intent":
      return "high_frequency_request";
    case "user_correction":
      return "repeat_clarification";
    case "tool_error":
      return "tool_chain_break";
    case "task_abandoned":
      return "long_time_to_value";
    case "explicit_feedback":
      return "user_rejection";
    default:
      return null;
  }
};

const thresholdForSignal = (
  signalType: Signal["signalType"],
  thresholds: DetectionThresholds
): number => {
  switch (signalType) {
    case "high_frequency_request":
      return thresholds.highFrequencyRequest;
    case "repeat_clarification":
      return thresholds.repeatClarification;
    case "manual_rescue":
      return thresholds.manualRescue;
    case "tool_chain_break":
      return thresholds.toolChainBreak;
    case "long_time_to_value":
      return 1;
    case "user_rejection":
      return thresholds.userRejection;
  }
};

export const detectUseCase = async (
  stateStore: StateStore,
  input: {
    since?: string;
    until?: string;
    thresholds?: DetectionThresholds;
    source?: string;
  } = {}
): Promise<{ signals: Signal[] }> => {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const events = await stateStore.listEvents({
    since: input.since,
    until: input.until,
    source: input.source
  });
  const grouped = new Map<string, typeof events>();
  for (const event of events) {
    const signalType = signalTypeFromEventType(event.type);
    if (!signalType) continue;
    const key = `${event.source}:${signalType}:${event.subject ?? "global"}`;
    const current = grouped.get(key) ?? [];
    current.push(event);
    grouped.set(key, current);
  }

  const signals: Signal[] = [];
  for (const [key, groupedEvents] of grouped.entries()) {
    const [source, signalType, subject] = key.split(":");
    const typedSignal = signalType as Signal["signalType"];
    if (groupedEvents.length < thresholdForSignal(typedSignal, thresholds)) continue;
    signals.push({
      id: `signal:${source}:${typedSignal}:${subject}`,
      windowStart: input.since ?? groupedEvents[0]?.ts ?? new Date(0).toISOString(),
      windowEnd: input.until ?? groupedEvents.at(-1)?.ts ?? new Date().toISOString(),
      source,
      signalType: typedSignal,
      subject,
      sessionIds: [...new Set(groupedEvents.map((event) => event.sessionId).filter(Boolean))] as string[],
      runIds: [...new Set(groupedEvents.map((event) => event.runId).filter(Boolean))] as string[],
      evidence: groupedEvents.map((event) => ({
        eventId: event.id,
        reason: `Observed ${event.type}`
      })),
      frequency: groupedEvents.length,
      severity: Math.min(1, 0.3 + groupedEvents.length * 0.1),
      confidence: Math.min(1, 0.4 + groupedEvents.length * 0.1),
      status: "new"
    });
  }

  await stateStore.upsertSignals(signals);
  return { signals };
};
