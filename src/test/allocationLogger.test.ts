// ===============================================
// TEST: src/test/allocationLogger.test.ts
// SPRINT 6: Allocation Logger + Performance Attribution
// ===============================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordAllocation,
  getHistoricalPerformance,
  getAllocationHistory,
  clearAllocationHistory,
  getAllocationCount,
} from "../core/persistence/allocationLogger";

// Sample allocation data for testing
const MOCK_ENGINE_RESULT = {
  regime: "EXPANSION",
  totalInvested: 0.85,
  totalPortfolioValue: 125000,
  portfolioDrawdown: -0.03,
  allocations: [
    { name: "BTC", ticker: "BTC-EUR", finalAllocation: 0.15, momentumScore: 0.7, valueScore: 0.3, qualityScore: 0.4, lowVolScore: 0.1, expectedReturn: 0.30, kellyFraction: 0.12 },
    { name: "WLG"  , ticker: "0P00000WLG.F", finalAllocation: 0.25, momentumScore: 0.6, valueScore: 0.5, qualityScore: 0.8, lowVolScore: 0.6, expectedReturn: 0.10, kellyFraction: 0.08 },
    { name: "VVSM" , ticker: "VVSM.DE", finalAllocation: 0.20, momentumScore: 0.8, valueScore: 0.2, qualityScore: 0.5, lowVolScore: 0.3, expectedReturn: 0.15, kellyFraction: 0.09 },
    { name: "PPFB", ticker: "PPFB.DE", finalAllocation: 0.15, momentumScore: 0.3, valueScore: 0.6, qualityScore: 0.7, lowVolScore: 0.8, expectedReturn: 0.06, kellyFraction: 0.05 },
    { name: "VVSM", ticker: "VVSM.DE", finalAllocation: 0.10, momentumScore: 0.5, valueScore: 0.4, qualityScore: 0.6, lowVolScore: 0.5, expectedReturn: 0.12, kellyFraction: 0.07 },
    { name: "EMXC", ticker: "EMXC.DE", finalAllocation: 0.10, momentumScore: 0.4, valueScore: 0.7, qualityScore: 0.5, lowVolScore: 0.4, expectedReturn: 0.08, kellyFraction: 0.06 },
    { name: "URNU", ticker: "URNU.DE", finalAllocation: 0.05, momentumScore: 0.2, valueScore: 0.8, qualityScore: 0.3, lowVolScore: 0.2, expectedReturn: 0.04, kellyFraction: 0.03 },
  ],
  regimePenalty: 0.85,
  coreSignalScore: 0.72,
  volTargetMultiplier: 0.90,
  tailRiskOverlay: 1.0,
  tailRiskActive: false,
  tailRiskReason: "",
  metaConfidence: "HIGH" as const,
  killSwitchLevel: 0 as const,
  engineVersion: "v5.2.0",
  factorWeights: { momentum: 0.35, value: 0.25, quality: 0.25, lowVol: 0.15 },
};

describe("AllocationLogger", () => {
  beforeEach(() => {
    clearAllocationHistory();
  });

  it("should record an allocation and return the record", () => {
    const record = recordAllocation(MOCK_ENGINE_RESULT);
    expect(record).toBeDefined();
    expect(record.regime).toBe("EXPANSION");
    expect(record.timestamp).toBeDefined();
    expect(record.totalInvested).toBe(0.85);
    expect(record.allocations).toHaveLength(7);
    expect(record.attribution).toBeDefined();
  });

  it("should compute attribution breakdown", () => {
    const record = recordAllocation(MOCK_ENGINE_RESULT);
    expect(record.attribution.regimeContribution).toBeGreaterThan(0);
    expect(record.attribution.factorContribution).toBeGreaterThan(0);
    expect(record.attribution.volPenalty).toBe(0.90);
    expect(record.attribution.tailPenalty).toBe(1.0);
    expect(record.attribution.modelQuality).toBe(1.0);
    expect(record.attribution.summary).toBeTruthy();
  });

  it("should compute attribution for tail risk active", () => {
    const tailRiskResult = { ...MOCK_ENGINE_RESULT, tailRiskActive: true, tailRiskOverlay: 0.60 };
    const record = recordAllocation(tailRiskResult);
    expect(record.attribution.tailPenalty).toBeLessThan(1);
    expect(record.attribution.summary).toContain("tail risk");
  });

  it("should compute attribution for LOW confidence", () => {
    const lowConfResult = { ...MOCK_ENGINE_RESULT, metaConfidence: "LOW" as const };
    const record = recordAllocation(lowConfResult);
    expect(record.attribution.modelQuality).toBe(0.50);
  });

  it("should store multiple records and retrieve them", () => {
    recordAllocation(MOCK_ENGINE_RESULT);
    recordAllocation({ ...MOCK_ENGINE_RESULT, regime: "CONTRACTION", totalInvested: 0.60 });

    expect(getAllocationCount()).toBe(2);
  });

  it("should return historical performance summary", () => {
    recordAllocation(MOCK_ENGINE_RESULT);
    recordAllocation({ ...MOCK_ENGINE_RESULT, regime: "CONTRACTION", totalInvested: 0.60 });
    recordAllocation({ ...MOCK_ENGINE_RESULT, regime: "CRISIS", totalInvested: 0.30 });

    const perf = getHistoricalPerformance();
    expect(perf.totalRecords).toBe(3);
    expect(perf.avgInvested).toBeCloseTo(0.583, 2);
    expect(perf.regimeDistribution["EXPANSION"]).toBe(1);
    expect(perf.regimeDistribution["CRISIS"]).toBe(1);
    expect(perf.avgVolTarget).toBe(0.90);
    expect(perf.avgTailOverlay).toBe(1.0);
    expect(perf.recentHistory).toHaveLength(3);
  });

  it("should detect allocation trends", () => {
    // First record: BTC at 20%
    recordAllocation({
      ...MOCK_ENGINE_RESULT,
      allocations: MOCK_ENGINE_RESULT.allocations.map(a =>
        a.name === "BTC" ? { ...a, finalAllocation: 0.20 } : a
      ),
    });
    // Second record: BTC at 10% (down)
    recordAllocation({
      ...MOCK_ENGINE_RESULT,
      allocations: MOCK_ENGINE_RESULT.allocations.map(a =>
        a.name === "BTC" ? { ...a, finalAllocation: 0.10 } : a
      ),
    });
    // Third record: BTC at 15% (current, up from avg)
    recordAllocation(MOCK_ENGINE_RESULT);

    const perf = getHistoricalPerformance();
    const btcTrend = perf.allocationTrends.find(t => t.name === "BTC");
    expect(btcTrend).toBeDefined();
    expect(btcTrend!.currentAllocation).toBe(0.15);
    expect(btcTrend!.avgAllocation30d).toBeCloseTo(0.15, 2); // (0.20 + 0.10 + 0.15) / 3
  });

  it("should return empty state when no records exist", () => {
    const perf = getHistoricalPerformance();
    expect(perf.totalRecords).toBe(0);
    expect(perf.firstDate).toBeNull();
    expect(perf.lastDate).toBeNull();
    expect(perf.recentHistory).toEqual([]);
    expect(perf.allocationTrends).toEqual([]);
  });

  it("should clear all records", () => {
    recordAllocation(MOCK_ENGINE_RESULT);
    expect(getAllocationCount()).toBe(1);
    clearAllocationHistory();
    expect(getAllocationCount()).toBe(0);
  });

  it("should limit to MAX_RECORDS", () => {
    // FIX-AUDIT-R8 3.6: reduced from 600 to 505 to avoid localStorage timing flakiness.
    // 505 records ensures at least one gets trimmed (MAX_RECORDS=500).
    for (let i = 0; i < 505; i++) {
      recordAllocation(MOCK_ENGINE_RESULT);
    }
    expect(getAllocationCount()).toBeLessThanOrEqual(500);
  });

  it("should preserve factor weights in records", () => {
    const fw = { momentum: 0.50, value: 0.20, quality: 0.20, lowVol: 0.10 };
    const record = recordAllocation({ ...MOCK_ENGINE_RESULT, factorWeights: fw });
    expect(record.factorWeights.momentum).toBe(0.50);
    expect(record.factorWeights.lowVol).toBe(0.10);
  });

  it("should use default factor weights when not provided", () => {
    const { factorWeights, ...rest } = MOCK_ENGINE_RESULT;
    const record = recordAllocation(rest);
    expect(record.factorWeights.momentum).toBe(0.25);
    expect(record.factorWeights.value).toBe(0.25);
    expect(record.factorWeights.quality).toBe(0.25);
    expect(record.factorWeights.lowVol).toBe(0.25);
  });

  it("getAllocationHistory should return all records sorted newest first", () => {
    const r1 = recordAllocation(MOCK_ENGINE_RESULT);
    const r2 = recordAllocation({ ...MOCK_ENGINE_RESULT, regime: "CONTRACTION" });
    const history = getAllocationHistory();
    expect(history).toHaveLength(2);
    expect(history[0].timestamp).toBe(r2.timestamp);
    expect(history[1].timestamp).toBe(r1.timestamp);
    expect(history[0].regime).toBe("CONTRACTION");
  });
});
