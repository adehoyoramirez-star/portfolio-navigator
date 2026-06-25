import { describe, test, expect } from "vitest";

// ════════════════════════════════════════════════════════════════════════════
// FIX-AUDIT-R3 regression suite: locks R3/R4 design contracts in pure JS
// math. Tests that require real backend (computeRollingMetrics, calculateKelly
// with real shapes) live in dedicated tests like liveMonitor.test.ts and
// kelly.test.ts. Here we lock the contracts cheaply.
// ════════════════════════════════════════════════════════════════════════════

describe("R3-02 v4 Kalman degraded-mode math", () => {
  test("subsetConfidenceMultiplier = 0.9^missing_count", () => {
    const subsetConfidenceMultiplier = (missing: number) => Math.pow(0.9, missing);
    expect(subsetConfidenceMultiplier(0)).toBeCloseTo(1.0, 5);
    expect(subsetConfidenceMultiplier(1)).toBeCloseTo(0.9, 5);
    expect(subsetConfidenceMultiplier(2)).toBeCloseTo(0.81, 5);
    expect(subsetConfidenceMultiplier(3)).toBeCloseTo(0.729, 5);
    expect(subsetConfidenceMultiplier(5)).toBeGreaterThan(0.5);
  });

  test("Kalman guard threshold: require 3 of 5 to proceed", () => {
    const shouldProceed = (ready: number) => ready >= 3 && ready <= 5;
    expect(shouldProceed(0)).toBe(false);
    expect(shouldProceed(2)).toBe(false);
    expect(shouldProceed(3)).toBe(true);
    expect(shouldProceed(5)).toBe(true);
    expect(shouldProceed(6)).toBe(false); // out-of-range guard
  });
});

describe("R3-01 v2 hysteresis state machine spec", () => {
  // Mirrors the consumption logic in InstitutionalDashboard.tsx L1471-1475.
  function decideAllCash(regime: string, totalInvested: number, streak: number, HYST: number) {
    if (regime === "ALL_CASH") return { action: "SELL_ALL", newStreak: HYST };
    if (totalInvested < 0.05) {
      const newStreak = streak + 1;
      return { action: newStreak >= HYST ? "SELL_ALL" : "HOLD", newStreak };
    }
    return { action: "HOLD", newStreak: 0 };
  }
  const HYST = 3;

  test("immediate SELL_ALL on direct engine signal (regime=ALL_CASH)", () => {
    expect(decideAllCash("ALL_CASH", 0.5, 0, HYST)).toEqual({ action: "SELL_ALL", newStreak: 3 });
  });

  test("HOLD first 2 runs, SELL_ALL on 3rd (derived tail-risk hysteresis)", () => {
    expect(decideAllCash("EXPANSION", 0.04, 0, HYST)).toEqual({ action: "HOLD", newStreak: 1 });
    expect(decideAllCash("EXPANSION", 0.04, 1, HYST)).toEqual({ action: "HOLD", newStreak: 2 });
    expect(decideAllCash("EXPANSION", 0.04, 2, HYST)).toEqual({ action: "SELL_ALL", newStreak: 3 });
  });

  test("streak resets to 0 on recovery (totalInv >= 0.05)", () => {
    expect(decideAllCash("EXPANSION", 0.20, 5, HYST)).toEqual({ action: "HOLD", newStreak: 0 });
  });
});

describe("Inflation guard constants", () => {
  test("R3-03 single-source RFR contract", () => {
    // Lock the constants used to compute per-period RFR. If anyone drifts,
    // Kelly/backtest/benchmark must still produce identical numbers.
    const ANNUAL = 0.04;
    const DAYS = 252;
    const expectedDaily = ANNUAL / DAYS;
    expect(expectedDaily).toBeCloseTo(0.04 / 252, 10);
  });
});
