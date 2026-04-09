import type { Opportunity } from "../domain/opportunity.js";
import type { PatternReference } from "../domain/pattern.js";
import type { Signal } from "../domain/signal.js";

export interface PatternSource {
  findPatterns(input: {
    opportunity: Opportunity;
    signals: Signal[];
    limit?: number;
  }): Promise<PatternReference[]>;
}
