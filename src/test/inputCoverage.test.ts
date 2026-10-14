import { describe, expect, it } from "vitest";
import {
  createBacktestCoverageManifest,
  FULL_PARITY_REQUIRED_FAMILIES,
  type BacktestSignalFamily,
} from "../core/backtest/inputCoverage";

const completeObserved = [...FULL_PARITY_REQUIRED_FAMILIES] as BacktestSignalFamily[];

describe("backtest historical-input coverage contract", () => {
  it("allows partial-input diagnostics but records missing signal families", () => {
    const manifest = createBacktestCoverageManifest({
      mode: "partial-input",
      start: "2023-10-09",
      end: "2026-08-17",
      observations: 1044,
      source: "versioned daily prices + observed FRED OAS",
      observed: ["asset_prices", "vix", "yield_spread", "credit_spread", "move", "dxy_trend", "btc_volatility"],
      unavailable: ["m2_growth", "oil", "central_bank_liquidity", "erp", "average_correlation", "btc_on_chain", "cycle_top", "sox_rsi", "inflation_breakeven", "asset_valuation"],
      fallback: ["m2_growth"],
    });
    expect(manifest.mode).toBe("partial-input");
    expect(manifest.fullParityEligible).toBe(false);
    expect(manifest.missingRequired).toContain("btc_on_chain");
    expect(manifest.fallback).toContain("m2_growth");
  });

  it("fails closed when full-parity is requested with a missing family", () => {
    expect(() => createBacktestCoverageManifest({
      mode: "full-parity",
      start: "2023-10-09",
      end: "2026-08-17",
      observations: 1044,
      source: "test",
      observed: completeObserved.filter(family => family !== "btc_on_chain"),
      unavailable: ["btc_on_chain"],
    })).toThrow(/Full-parity backtest refused.*btc_on_chain/);
  });

  it("marks full parity eligible only when every required family is observed", () => {
    const manifest = createBacktestCoverageManifest({
      mode: "full-parity",
      start: "2023-10-09",
      end: "2026-08-17",
      observations: 1044,
      source: "complete point-in-time fixture",
      observed: completeObserved,
      unavailable: [],
    });
    expect(manifest.fullParityEligible).toBe(true);
    expect(manifest.missingRequired).toEqual([]);
  });

  it("does not let fallback values count as observed historical data", () => {
    expect(() => createBacktestCoverageManifest({
      mode: "full-parity",
      start: "2023-10-09",
      end: "2026-08-17",
      observations: 1044,
      source: "test",
      observed: completeObserved.filter(family => family !== "m2_growth"),
      unavailable: [],
      fallback: ["m2_growth"],
    })).toThrow(/m2_growth/);
  });
});
