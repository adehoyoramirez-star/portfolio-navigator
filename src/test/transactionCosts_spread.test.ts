// FASE 3B · CORRECCIÓN 1 — computeTradeCost debe cobrar el SPREAD COMPLETO (2 × halfSpreadBps),
// coherente con el motor (backtestEngine: halfSpreadBps × 2 / 10_000).
import { describe, test, expect } from "vitest";
import { computeTradeCost, computeRebalanceCost, ASSET_COST_PARAMS } from "../core/validation/transactionCosts";

describe("CORRECCIÓN 1 — spread completo en computeTradeCost", () => {
  test("spreadCost = turnover × (2 × halfSpreadBps) / 10_000 para cada activo", () => {
    const pv = 100_000;
    const newWeight = 0.10;
    const turnoverEur = newWeight * pv;
    for (const ticker of Object.keys(ASSET_COST_PARAMS)) {
      const out = computeTradeCost({ ticker, oldWeight: 0, newWeight, portfolioValueEur: pv, priceEur: 100 });
      const expected = turnoverEur * ((ASSET_COST_PARAMS[ticker].halfSpreadBps * 2) / 10_000);
      expect(out.breakdown.spreadCost, ticker).toBeCloseTo(expected, 6);
      // NO es el medio spread
      expect(out.breakdown.spreadCost, ticker).toBeGreaterThan(
        turnoverEur * (ASSET_COST_PARAMS[ticker].halfSpreadBps / 10_000) * 1.99
      );
    }
  });

  test("coherente con el coste del motor (halfSpreadBps*2/10000)", () => {
    const pv = 50_000;
    const w = 0.08;
    const o = computeTradeCost({ ticker: "BTC-EUR", oldWeight: 0, newWeight: w, portfolioValueEur: pv, priceEur: 1000 });
    const engineRate = (ASSET_COST_PARAMS["BTC-EUR"].halfSpreadBps * 2) / 10_000;
    expect(o.breakdown.spreadCost).toBeCloseTo(w * pv * engineRate, 6);
  });

  test("sin turnover (mismo peso) → coste 0", () => {
    const o = computeTradeCost({ ticker: "VVSM.DE", oldWeight: 0.2, newWeight: 0.2, portfolioValueEur: 100_000, priceEur: 100 });
    expect(o.totalCostEur).toBe(0);
    expect(o.breakdown.spreadCost).toBe(0);
  });

  test("computeRebalanceCost usa el spread completo", () => {
    const out = computeRebalanceCost({
      oldAllocations: { "VVSM.DE": 0 },
      newAllocations: { "VVSM.DE": 0.10 },
      portfolioValueEur: 100_000,
      prices: { "VVSM.DE": 100 },
    });
    expect(out.trades[0].breakdown.spreadCost).toBeCloseTo(10_000 * ((4 * 2) / 10_000), 6);
  });
});
