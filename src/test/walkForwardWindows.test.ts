import { describe, expect, test } from "vitest";
import { buildWindows, formatWFResult, runWalkForwardTest, type WFTestConfig } from "../core/backtest/walkForwardTest";

const config: WFTestConfig = {
  nWindows: 3,
  trainRatio: 0.70,
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

describe("buildWindows — expanding walk-forward boundaries", () => {
  test("uses 70% initial IS and contiguous OOS windows with enough rebalance cycles", () => {
    const totalDays = 1_579;
    const windows = buildWindows(totalDays, config);

    expect(windows).toHaveLength(3);
    expect(windows[0].trainEnd).toBe(Math.floor(totalDays * 0.70));
    expect(windows[0].testStart).toBe(windows[0].trainEnd);
    expect(windows[0].trainStart).toBe(0);
    expect(windows[windows.length - 1].testEnd).toBe(totalDays);

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      expect(window.trainDays).toBe(window.trainEnd);
      expect(window.testDays).toBeGreaterThanOrEqual(21);
      expect(window.testEnd - window.testStart).toBe(window.testDays);
      if (i > 0) {
        expect(window.testStart).toBe(windows[i - 1].testEnd);
        expect(window.trainEnd).toBe(windows[i - 1].trainEnd + windows[i - 1].testDays);
      }
    }
  });

  test("rejects five 63-day-rebalance windows that would trigger lookback fallback", () => {
    expect(buildWindows(1_579, { ...config, nWindows: 5 })).toEqual([]);
  });

  test("rejects invalid configuration and insufficient OOS history", () => {
    expect(buildWindows(1_000, { ...config, trainRatio: 1 })).toEqual([]);
    expect(buildWindows(300, config)).toEqual([]);
  });
});


describe("statistical metrics fail closed until validated", () => {
  test("does not publish numeric DSR/PSR when there is insufficient data", () => {
    const result = runWalkForwardTest({ closesHistory: {} }, config);

    expect(result.statisticalMetricsStatus).toBe("UNAVAILABLE_NOT_VALIDATED");
    expect(result.deflatedSharpeRatio).toBeNull();
    expect(result.probabilisticSharpeRatio).toBeNull();

    const formatted = formatWFResult(result);
    expect(formatted).toContain("DSR: NO DISPONIBLE");
    expect(formatted).toContain("PSR: NO DISPONIBLE");
  });
});
