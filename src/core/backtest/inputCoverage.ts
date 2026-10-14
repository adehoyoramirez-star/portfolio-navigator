/**
 * Explicit historical-input coverage contract for Olympus backtests.
 *
 * "partial-input" is diagnostic only; "full-parity" must fail closed unless
 * every required signal family is backed by observed historical data.
 */
export type BacktestCoverageMode = "partial-input" | "full-parity";

export type BacktestSignalFamily =
  | "asset_prices"
  | "vix"
  | "yield_spread"
  | "credit_spread"
  | "move"
  | "dxy_trend"
  | "btc_volatility"
  | "m2_growth"
  | "oil"
  | "central_bank_liquidity"
  | "erp"
  | "average_correlation"
  | "btc_on_chain"
  | "cycle_top"
  | "sox_rsi"
  | "inflation_breakeven"
  | "asset_valuation";

export interface BacktestSeriesMetadata {
  family: BacktestSignalFamily;
  source: string;
  units: string;
  timestampConvention: string;
  freshnessThresholdDays: number | null;
  carryForwardRule: string;
  missingCount: number | null;
  fallbackCount: number;
  sourceRowCount?: number | null;
  observedCount?: number | null;
  blankSourceRows?: number | null;
  carriedForwardCount?: number | null;
  maxObservedAgeDays?: number | null;
}

export interface BacktestCoverageManifest {
  schemaVersion: 2;
  mode: BacktestCoverageMode;
  generatedAt: string;
  period: { start: string; end: string; observations: number };
  source: string;
  observed: BacktestSignalFamily[];
  unavailable: BacktestSignalFamily[];
  fallback: BacktestSignalFamily[];
  requiredForFullParity: BacktestSignalFamily[];
  missingRequired: BacktestSignalFamily[];
  fullParityEligible: boolean;
  seriesMetadata: BacktestSeriesMetadata[];
}

export const FULL_PARITY_REQUIRED_FAMILIES: readonly BacktestSignalFamily[] = [
  "asset_prices",
  "vix",
  "yield_spread",
  "credit_spread",
  "move",
  "dxy_trend",
  "btc_volatility",
  "m2_growth",
  "oil",
  "central_bank_liquidity",
  "erp",
  "average_correlation",
  "btc_on_chain",
  "cycle_top",
  "sox_rsi",
  "inflation_breakeven",
  "asset_valuation",
] as const;

export function createBacktestCoverageManifest(input: {
  mode: BacktestCoverageMode;
  start: string;
  end: string;
  observations: number;
  source: string;
  observed: BacktestSignalFamily[];
  unavailable: BacktestSignalFamily[];
  fallback?: BacktestSignalFamily[];
  seriesMetadata?: BacktestSeriesMetadata[];
}): BacktestCoverageManifest {
  const observed = [...new Set(input.observed)];
  const unavailable = [...new Set(input.unavailable)];
  const fallback = [...new Set(input.fallback ?? [])];
  const observedSet = new Set(observed);
  const missingRequired = FULL_PARITY_REQUIRED_FAMILIES.filter(
    family => !observedSet.has(family),
  );
  const manifest: BacktestCoverageManifest = {
    schemaVersion: 2,
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    period: {
      start: input.start,
      end: input.end,
      observations: input.observations,
    },
    source: input.source,
    observed,
    unavailable,
    fallback,
    requiredForFullParity: [...FULL_PARITY_REQUIRED_FAMILIES],
    missingRequired: [...missingRequired],
    fullParityEligible: missingRequired.length === 0,
    // Unknown metadata stays explicit; never infer provenance or quality.
    seriesMetadata: (input.seriesMetadata ?? []).map(item => ({
      ...item,
      freshnessThresholdDays:
        Number.isFinite(item.freshnessThresholdDays) && item.freshnessThresholdDays! >= 0
          ? item.freshnessThresholdDays
          : null,
      missingCount:
        Number.isFinite(item.missingCount) && item.missingCount! >= 0
          ? item.missingCount
          : null,
      fallbackCount: Number.isFinite(item.fallbackCount) && item.fallbackCount >= 0
        ? item.fallbackCount
        : 0,
      sourceRowCount: Number.isFinite(item.sourceRowCount) && item.sourceRowCount! >= 0
        ? item.sourceRowCount
        : null,
      observedCount: Number.isFinite(item.observedCount) && item.observedCount! >= 0
        ? item.observedCount
        : null,
      blankSourceRows: Number.isFinite(item.blankSourceRows) && item.blankSourceRows! >= 0
        ? item.blankSourceRows
        : null,
      carriedForwardCount: Number.isFinite(item.carriedForwardCount) && item.carriedForwardCount! >= 0
        ? item.carriedForwardCount
        : null,
      maxObservedAgeDays: Number.isFinite(item.maxObservedAgeDays) && item.maxObservedAgeDays! >= 0
        ? item.maxObservedAgeDays
        : null,
    })),
  };

  if (input.mode === "full-parity" && !manifest.fullParityEligible) {
    throw new Error(
      `Full-parity backtest refused: missing observed signal families: ${missingRequired.join(", ")}. ` +
      "Supply point-in-time historical series; do not replace missing history with constants or synthetic observations.",
    );
  }
  return manifest;
}
