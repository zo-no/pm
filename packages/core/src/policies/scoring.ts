export interface OpportunityScoreInput {
  impactScore: number;
  confidenceScore: number;
  effortScore: number;
  riskScore: number;
  strategyFit: number;
}

export const calculatePriorityScore = (input: OpportunityScoreInput): number => {
  const numerator = input.impactScore * input.confidenceScore * input.strategyFit;
  const denominator = Math.max(0.1, input.effortScore * input.riskScore);
  return Number((numerator / denominator).toFixed(2));
};
