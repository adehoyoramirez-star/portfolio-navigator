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

export interface BacktestCoverageManifest {
  schemaVersion: 1;
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
}): BacktestCoverageManifest {
  const observed = [...new Set(input.observed)];
  const unavailable = [...new Set(input.unavailable)];
  const fallback = [...new Set(input.fallback ?? [])];
  const observedSet = new Set(observed);
  const missingRequired = FULL_PARITY_REQUIRED_FAMILIES.filter(
    family => !observedSet.has(family),
  );
  const manifest: BacktestCoverageManifest = {
    schemaVersion: 1,
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
  };

  if (input.mode === "full-parity" && !manifest.fullParityEligible) {
    throw new Error(
      `Full-parity backtest refused: missing observed signal families: ${missingRequired.join(", ")}. ` +
      "Supply point-in-time historical series; do not replace missing history with constants or synthetic observations.",
    );
  }
  return manifest;
}
