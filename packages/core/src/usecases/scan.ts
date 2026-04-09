import type { Clock } from "../ports/clock.js";
import type { EventSource } from "../ports/event-source.js";
import type { StateStore } from "../ports/state-store.js";

export interface ScanUseCaseDeps {
  clock: Clock;
  eventSource: EventSource;
  stateStore: StateStore;
}

export const scanUseCase = async (
  deps: ScanUseCaseDeps,
  input: { since: string; cursor?: string }
): Promise<{ scanned: number; nextCursor?: string; at: string }> => {
  const { events, nextCursor } = await deps.eventSource.fetchEvents(input);
  await deps.stateStore.appendEvents(events);
  return {
    scanned: events.length,
    nextCursor,
    at: deps.clock.isoNow()
  };
};
