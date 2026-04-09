export type SignalType =
  | "high_frequency_request"
  | "repeat_clarification"
  | "manual_rescue"
  | "tool_chain_break"
  | "long_time_to_value"
  | "user_rejection";

export type SignalStatus = "new" | "observing" | "promoted" | "dismissed";

export interface SignalEvidence {
  eventId: string;
  reason: string;
}

export interface Signal {
  id: string;
  windowStart: string;
  windowEnd: string;
  source: string;
  signalType: SignalType;
  subject: string;
  sessionIds: string[];
  runIds: string[];
  evidence: SignalEvidence[];
  frequency: number;
  severity: number;
  confidence: number;
  status: SignalStatus;
}
