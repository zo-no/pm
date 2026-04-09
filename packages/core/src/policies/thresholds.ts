export interface DetectionThresholds {
  highFrequencyRequest: number;
  repeatClarification: number;
  manualRescue: number;
  toolChainBreak: number;
  longTimeToValueMs: number;
  userRejection: number;
}

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  highFrequencyRequest: 3,
  repeatClarification: 2,
  manualRescue: 1,
  toolChainBreak: 2,
  longTimeToValueMs: 15 * 60 * 1000,
  userRejection: 1
};
