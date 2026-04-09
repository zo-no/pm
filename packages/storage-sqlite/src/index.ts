import type {
  Decision,
  Event,
  Experiment,
  Opportunity,
  Signal,
  SpecDraft,
  StateStore
} from "@pm-loop/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SqliteStateStoreOptions {
  filePath: string;
}

interface JsonStateFile {
  events: Event[];
  signals: Signal[];
  opportunities: Opportunity[];
  specs: SpecDraft[];
  experiments: Experiment[];
  decisions: Decision[];
}

const EMPTY_STATE: JsonStateFile = {
  events: [],
  signals: [],
  opportunities: [],
  specs: [],
  experiments: [],
  decisions: []
};

const upsertById = <T extends { id: string }>(existing: T[], incoming: T[]): T[] => {
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
};

export class JsonFileStateStore implements StateStore {
  constructor(private readonly options: SqliteStateStoreOptions) {}

  private async readState(): Promise<JsonStateFile> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      return {
        ...EMPTY_STATE,
        ...JSON.parse(raw)
      } as JsonStateFile;
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private async writeState(state: JsonStateFile): Promise<void> {
    await mkdir(dirname(this.options.filePath), { recursive: true });
    await writeFile(this.options.filePath, JSON.stringify(state, null, 2));
  }

  async appendEvents(events: Event[]): Promise<void> {
    const state = await this.readState();
    state.events = upsertById(state.events, events);
    await this.writeState(state);
  }

  async listEvents(input: { since?: string; until?: string; source?: string } = {}): Promise<Event[]> {
    const state = await this.readState();
    return state.events.filter((event) => {
      if (input.source && event.source !== input.source) return false;
      if (input.since && event.ts < input.since) return false;
      if (input.until && event.ts > input.until) return false;
      return true;
    });
  }

  async upsertSignals(signals: Signal[]): Promise<void> {
    const state = await this.readState();
    state.signals = upsertById(state.signals, signals);
    await this.writeState(state);
  }

  async listSignals(input: { statuses?: Signal["status"][]; source?: string } = {}): Promise<Signal[]> {
    const state = await this.readState();
    return state.signals.filter((signal) => {
      if (input.source && signal.source !== input.source) return false;
      if (input.statuses && !input.statuses.includes(signal.status)) return false;
      return true;
    });
  }

  async upsertOpportunities(opportunities: Opportunity[]): Promise<void> {
    const state = await this.readState();
    state.opportunities = upsertById(state.opportunities, opportunities);
    await this.writeState(state);
  }

  async listOpportunities(input: { statuses?: Opportunity["status"][]; source?: string } = {}): Promise<Opportunity[]> {
    const state = await this.readState();
    return state.opportunities.filter((opportunity) => {
      if (input.source && opportunity.source !== input.source) return false;
      if (input.statuses && !input.statuses.includes(opportunity.status)) return false;
      return true;
    });
  }

  async saveSpec(spec: SpecDraft): Promise<void> {
    const state = await this.readState();
    state.specs = upsertById(state.specs, [spec]);
    await this.writeState(state);
  }

  async getSpecByOpportunityId(opportunityId: string): Promise<SpecDraft | undefined> {
    const state = await this.readState();
    return state.specs.find((spec) => spec.opportunityId === opportunityId);
  }

  async saveExperiment(experiment: Experiment): Promise<void> {
    const state = await this.readState();
    state.experiments = upsertById(state.experiments, [experiment]);
    await this.writeState(state);
  }

  async listExperiments(): Promise<Experiment[]> {
    const state = await this.readState();
    return state.experiments;
  }

  async appendDecision(decision: Decision): Promise<void> {
    const state = await this.readState();
    state.decisions = upsertById(state.decisions, [decision]);
    await this.writeState(state);
  }
}

export class SqliteStateStore implements StateStore {
  constructor(private readonly options: SqliteStateStoreOptions) {
    void this.options;
  }

  async appendEvents(_events: Event[]): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async listEvents(): Promise<Event[]> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async upsertSignals(_signals: Signal[]): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async listSignals(): Promise<Signal[]> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async upsertOpportunities(_opportunities: Opportunity[]): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async listOpportunities(): Promise<Opportunity[]> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async saveSpec(_spec: SpecDraft): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async getSpecByOpportunityId(): Promise<SpecDraft | undefined> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async saveExperiment(_experiment: Experiment): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async listExperiments(): Promise<Experiment[]> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }

  async appendDecision(_decision: Decision): Promise<void> {
    throw new Error("SqliteStateStore is not implemented yet.");
  }
}
