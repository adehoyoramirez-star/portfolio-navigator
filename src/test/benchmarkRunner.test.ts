// ===============================================
// TEST: src/test/benchmarkRunner.test.ts
// Sprint 3: Benchmark Runner — 60/40 vs Engine
// ===============================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordBenchmarkSnapshot,
  getBenchmarkStatus,
  getBenchmarkHistory,
  clearBenchmarkHistory,
  getBenchmarkWeight,
  getBenchmarkComposition,
} from "../core/benchmark/benchmarkRunner";

const TEST_PRICES_1: Record<string, number> = {
  "BTC-EUR": 45000,
  "EMXC.DE": 29.5,
  "0P00000WLG.F": 68,
  "PPFB.DE": 70,
  "URNU.DE": 27,
  "VVSM.DE": 53,
};

const TEST_PRICES_2: Record<string, number> = {
  "BTC-EUR": 46000,
  "EMXC.DE": 29.8,
  "0P00000WLG.F": 69,
  "PPFB.DE": 69.5,
  "URNU.DE": 27.2,
  "VVSM.DE": 54,
};

const TEST_PRICES_BEAR: Record<string, number> = {
  "BTC-EUR": 32000,
  "EMXC.DE": 25,
  "0P00000WLG.F": 55,
  "PPFB.DE": 65,
  "URNU.DE": 22,
  "VVSM.DE": 40,
};

beforeEach(() => {
  clearBenchmarkHistory();
  localStorage.clear();
});

describe("recordBenchmarkSnapshot", () => {
  it("returns null on first snapshot", () => {
    const result = recordBenchmarkSnapshot({
      portfolioValue: 100000,
      totalInvested: 0.85,
      regime: "EXPANSION",
      prices: TEST_PRICES_1,
    });
    expect(result).toBeNull();
  });

  it("returns a record with engine and benchmark returns on second snapshot", () => {
    recordBenchmarkSnapshot({
      portfolioValue: 100000,
      totalInvested: 0.85,
      regime: "EXPANSION",
      prices: TEST_PRICES_1,
    });

    const result = recordBenchmarkSnapshot({
      portfolioValue: 102000,
      totalInvested: 0.80,
      regime: "EXPANSION",
      prices: TEST_PRICES_2,
    });

    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeDefined();
    expect(result!.engineReturn).toBeCloseTo(0.02, 4);
    expect(result!.totalInvested).toBe(0.80);
    expect(result!.regime).toBe("EXPANSION");

    // BTC-EUR: 46000/45000 - 1 = 0.02222 * 0.10 = 0.002222
    // EMXC.DE: 29.8/29.5 - 1 = 0.01017 * 0.10 = 0.001017
    // WLG: 69/68 - 1 = 0.01471 * 0.35 = 0.005149
    // PPFB.DE: 69.5/70 - 1 = -0.00714 * 0.20 = -0.001429
    // URNU.DE: 27.2/27 - 1 = 0.00741 * 0.10 = 0.000741
    // VVSM.DE: 54/53 - 1 = 0.01887 * 0.15 = 0.002831
    // VVSM: 54/53 - 1 = 0.01887 * 0.15 = 0.002831
    // Total = 0.01053
    expect(result!.benchmarkReturn).toBeCloseTo(0.01053, 4);
  });

  it("handles bear market scenario", () => {
    recordBenchmarkSnapshot({
      portfolioValue: 110000,
      totalInvested: 0.90,
      regime: "EXPANSION",
      prices: TEST_PRICES_1,
    });

    const result = recordBenchmarkSnapshot({
      portfolioValue: 90000,
      totalInvested: 0.60,
      regime: "CRISIS",
      prices: TEST_PRICES_BEAR,
    });

    expect(result).not.toBeNull();
    expect(result!.engineReturn).toBeCloseTo(-0.1818, 3);
    expect(result!.benchmarkReturn).toBeLessThan(-0.15);
    expect(result!.regime).toBe("CRISIS");
  });

  it("persists data across multiple snapshots", () => {
    recordBenchmarkSnapshot({
      portfolioValue: 100000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_1,
    });
    recordBenchmarkSnapshot({
      portfolioValue: 102000, totalInvested: 0.80, regime: "EXPANSION", prices: TEST_PRICES_2,
    });
    recordBenchmarkSnapshot({
      portfolioValue: 98000, totalInvested: 0.70, regime: "CONTRACTION", prices: TEST_PRICES_BEAR,
    });

    const status = getBenchmarkStatus();
    expect(status.dataPoints).toBe(2);
    expect(status.lastUpdated).toBeDefined();
  });
});

describe("getBenchmarkStatus", () => {
  it("returns collecting message with < 2 records", () => {
    recordBenchmarkSnapshot({
      portfolioValue: 100000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_1,
    });

    const status = getBenchmarkStatus();
    expect(status.dataPoints).toBe(0);
    expect(status.message).toContain("Recolectando");
    expect(status.underperformanceAlert).toBe(false);
  });

  it("computes stats with sufficient data points", () => {
    let value = 100000;
    let btc = 45000;

    for (let i = 0; i < 65; i++) {
      const variation = 1 + (Math.random() - 0.5) * 0.003;
      const btcVariation = 1 + (Math.random() - 0.5) * 0.006;
      value *= variation;
      btc *= btcVariation;

      const prices: Record<string, number> = { ...TEST_PRICES_1, "BTC-EUR": btc };
      Object.keys(prices).forEach((ticker) => {
        if (ticker !== "BTC-EUR") prices[ticker] *= variation;
      });

      recordBenchmarkSnapshot({
        portfolioValue: value, totalInvested: 0.85, regime: "EXPANSION", prices,
      });
    }

    const status = getBenchmarkStatus();
    expect(status.dataPoints).toBe(64);
    expect(status.engineCagr3m).toBeGreaterThan(-5);
    expect(status.benchmarkCagr3m).toBeGreaterThan(-5);
    expect(status.engineTotalReturn).toBeGreaterThan(-0.99);
    expect(status.benchmarkTotalReturn).toBeGreaterThan(-0.99);
    expect(status.message).toBeDefined();
  });
});

describe("getBenchmarkWeight", () => {
  it("returns correct weights for known tickers", () => {
    expect(getBenchmarkWeight("0P00000WLG.F")).toBeCloseTo(0.35, 4);
    expect(getBenchmarkWeight("VVSM.DE")).toBeCloseTo(0.15, 4);
    expect(getBenchmarkWeight("PPFB.DE")).toBeCloseTo(0.20, 4);
    expect(getBenchmarkWeight("BTC-EUR")).toBeCloseTo(0.10, 4);
  });

  it("returns 0 for unknown tickers", () => {
    expect(getBenchmarkWeight("NONEXISTENT.DE")).toBe(0);
  });
});

describe("getBenchmarkComposition", () => {
  it("returns sorted composition with all assets", () => {
    const comp = getBenchmarkComposition();
    expect(comp.length).toBe(6);
    expect(comp[0].ticker).toBe("PPFB.DE");
    expect(comp[0].weight).toBeCloseTo(0.25, 4);
    expect(comp[comp.length - 1].ticker).toBe("URNU.DE");
    expect(comp[comp.length - 1].weight).toBeCloseTo(0.05, 4);
  });

  it("only includes tickers with weight > 0", () => {
    const comp = getBenchmarkComposition();
    comp.forEach((x) => expect(x.weight).toBeGreaterThan(0));
  });
});

describe("getBenchmarkHistory", () => {
  it("returns empty array when no data", () => {
    expect(getBenchmarkHistory()).toEqual([]);
  });

  it("returns records in chronological order", () => {
    recordBenchmarkSnapshot({
      portfolioValue: 100000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_1,
    });
    recordBenchmarkSnapshot({
      portfolioValue: 101000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_2,
    });

    const history = getBenchmarkHistory();
    expect(history.length).toBe(1);
    expect(history[0].engineReturn).toBeCloseTo(0.01, 4);
  });
});

describe("clearBenchmarkHistory", () => {
  it("clears all stored data", () => {
    recordBenchmarkSnapshot({ portfolioValue: 100000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_1 });
    recordBenchmarkSnapshot({ portfolioValue: 101000, totalInvested: 0.85, regime: "EXPANSION", prices: TEST_PRICES_2 });

    expect(getBenchmarkStatus().dataPoints).toBe(1);
    clearBenchmarkHistory();
    expect(getBenchmarkStatus().dataPoints).toBe(0);
    expect(getBenchmarkHistory()).toEqual([]);
  });
});
