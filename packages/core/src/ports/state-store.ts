import type { Decision } from "../domain/decision.js";
import type { Event } from "../domain/event.js";
import type { Experiment } from "../domain/experiment.js";
import type { Opportunity, OpportunityStatus } from "../domain/opportunity.js";
import type { Signal } from "../domain/signal.js";
import type { SpecDraft } from "../domain/spec.js";

export interface StateStore {
  appendEvents(events: Event[]): Promise<void>;
  listEvents(input?: { since?: string; until?: string; source?: string }): Promise<Event[]>;
  upsertSignals(signals: Signal[]): Promise<void>;
  listSignals(input?: { statuses?: Signal["status"][]; source?: string }): Promise<Signal[]>;
  upsertOpportunities(opportunities: Opportunity[]): Promise<void>;
  listOpportunities(input?: { statuses?: OpportunityStatus[]; source?: string }): Promise<Opportunity[]>;
  saveSpec(spec: SpecDraft): Promise<void>;
  getSpecByOpportunityId(opportunityId: string): Promise<SpecDraft | undefined>;
  saveExperiment(experiment: Experiment): Promise<void>;
  listExperiments(): Promise<Experiment[]>;
  appendDecision(decision: Decision): Promise<void>;
}
