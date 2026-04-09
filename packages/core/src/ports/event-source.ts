import type { Event, EventWindow } from "../domain/event.js";

export interface EventSource {
  fetchEvents(input: EventWindow): Promise<{
    events: Event[];
    nextCursor?: string;
  }>;
}
