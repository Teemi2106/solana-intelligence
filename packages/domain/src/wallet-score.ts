export const walletScoreVersion = "wallet-score-v1";

export interface WalletScoreInputs {
  readonly completedTrades: number;
  readonly winRateBps: number | null;
  readonly profitableTokenCount: number;
  readonly largestTradeProfitContributionBps: number | null;
  readonly maxDrawdownBps: number | null;
  readonly recentProfitabilityBps: number | null;
  readonly copyableTradeRatioBps: number;
  readonly allocationProfitRatioBps: number;
  readonly dataConfidenceBps: number;
}

export interface WalletScoreResult {
  readonly version: typeof walletScoreVersion;
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
  readonly inputs: WalletScoreInputs;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function scoreWallet(inputs: WalletScoreInputs): WalletScoreResult {
  const sample = clamp(Math.min(inputs.completedTrades / 30, 1) * 100);
  const repeatability = clamp(((inputs.winRateBps ?? 0) / 10000) * 100);
  const diversity = clamp(Math.min(inputs.profitableTokenCount / 12, 1) * 100);
  const concentration = clamp(100 - (inputs.largestTradeProfitContributionBps ?? 10000) / 100);
  const drawdown = clamp(100 - (inputs.maxDrawdownBps ?? 10000) / 100);
  const recency = clamp((inputs.recentProfitabilityBps ?? 0) / 100);
  const copyability = clamp(inputs.copyableTradeRatioBps / 100 - inputs.allocationProfitRatioBps / 200);
  const confidence = clamp(inputs.dataConfidenceBps / 100);
  const weighted = sample * 0.15 + repeatability * 0.2 + diversity * 0.1 + concentration * 0.15 + drawdown * 0.1 + recency * 0.1 + copyability * 0.15 + confidence * 0.05;
  return { version: walletScoreVersion, score: clamp(weighted), components: { sample, repeatability, diversity, concentration, drawdown, recency, copyability, confidence }, inputs };
}
