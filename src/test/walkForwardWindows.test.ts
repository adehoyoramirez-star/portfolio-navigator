import { describe, expect, test } from "vitest";
import { buildWindows, type WFTestConfig } from "../core/backtest/walkForwardTest";

const config: WFTestConfig = {
  nWindows: 5,
  trainRatio: 0.70,
  lookbackDays: 252,
  rebalanceDays: 63,
  initialCapital: 10_000,
  transactionCostBps: 15,
};

describe("buildWindows — expanding walk-forward boundaries", () => {
  test("uses 70% initial IS and contiguous OOS windows through the final index", () => {
    const totalDays = 1_579;
    const windows = buildWindows(totalDays, config);

    expect(windows).toHaveLength(5);
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

  test("rejects invalid configuration and insufficient OOS history", () => {
    expect(buildWindows(1_000, { ...config, trainRatio: 1 })).toEqual([]);
    expect(buildWindows(300, config)).toEqual([]);
  });
});
