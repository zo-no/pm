import type { Opportunity, PatternReference, PatternSource, Signal } from "@pm-loop/core";
import { readFile } from "node:fs/promises";

export interface LocalPatternSourceOptions {
  filePath: string;
}

const normalize = (value: string): string => value.toLowerCase();

const scorePattern = (pattern: PatternReference, opportunity: Opportunity, signals: Signal[]): number => {
  const haystacks = [
    opportunity.title,
    opportunity.problem,
    ...signals.map((signal) => signal.subject)
  ].map((value) => normalize(value));

  return pattern.tags.reduce((score, tag) => {
    const normalizedTag = normalize(tag);
    return haystacks.some((value) => value.includes(normalizedTag)) ? score + 2 : score;
  }, 0);
};

export class LocalPatternSource implements PatternSource {
  constructor(private readonly options: LocalPatternSourceOptions) {}

  async findPatterns(input: {
    opportunity: Opportunity;
    signals: Signal[];
    limit?: number;
  }): Promise<PatternReference[]> {
    let patterns: PatternReference[] = [];
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      patterns = JSON.parse(raw) as PatternReference[];
    } catch {
      return [];
    }
    const ranked = patterns
      .map((pattern) => ({
        pattern,
        score: scorePattern(pattern, input.opportunity, input.signals)
      }))
      .sort((a, b) => b.score - a.score || a.pattern.title.localeCompare(b.pattern.title))
      .map((item) => item.pattern);

    const selected = ranked.slice(0, input.limit ?? 3);
    return selected.length > 0 ? selected : patterns.slice(0, input.limit ?? 3);
  }
}
