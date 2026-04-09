import type { ExperimentOutcome } from "../domain/experiment.js";

export interface OutcomeReader {
  fetchOutcome(input: { experimentId: string }): Promise<ExperimentOutcome>;
}
