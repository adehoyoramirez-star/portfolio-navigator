// ================================================
// SMOKE TEST G5 — validez de outputs del motor
// ================================================
// Garantiza (de forma determinista, sin preview de Vercel) que los outputs
// principales del motor son FINITOS y están dentro de rangos válidos:
//   - allocation / allocationMultiplier: finito, [0, 1]
//   - trimPct: finito, [0, 100]
//   - pesos del motor: suman ~1 y son finitos
//   - totalInvested / volTargetMultiplier / tailRiskOverlay: finitos
// Si un NaN/Infinity contamina la cadena, este test lo detecta en CI (G1).
// ================================================
import { describe, test, expect } from "vitest";
import { runOlympusEngine, type OlympusEngineInput } from "../core/engine/olympusV3";
import { detectCycleTops, detectCycleBottoms, type CycleTopInputs } from "../core/risk/cycleTopDetector";
import { computeAllocation } from "../core/quant/capitalAllocator";

const isFinite = Number.isFinite;

// Universe real del portfolio (6 activos)
function engineInput(overrides: Partial<OlympusEngineInput> = {}): OlympusEngineInput {
  return {
    assets: [
      { name: "Bitcoin",        ticker: "BTC-EUR",      returns12m: 0.20, returns3m: -0.05, returns1m: -0.02, earningsYield: 0,    volatility: 0.60, sector: "crypto" },
      { name: "Semiconductors", ticker: "VVSM.DE",      returns12m: 0.40, returns3m:  0.05, returns1m:  0.01, earningsYield: 0.03, volatility: 0.35, sector: "tech" },
      { name: "Vanguard World", ticker: "0P00000WLG.F", returns12m: 0.18, returns3m:  0.04, returns1m:  0.01, earningsYield: 0.04, volatility: 0.15, sector: "equity" },
      { name: "Uranium",        ticker: "URNU.DE",      returns12m: 0.10, returns3m: -0.08, returns1m: -0.01, earningsYield: 0.02, volatility: 0.40, sector: "commodity" },
      { name: "Emerging Mkts",  ticker: "EMXC.DE",      returns12m: 0.15, returns3m:  0.00, returns1m: -0.01, earningsYield: 0.05, volatility: 0.20, sector: "equity" },
      { name: "Gold ETC",       ticker: "PPFB.DE",      returns12m: 0.12, returns3m:  0.03, returns1m:  0.02, earningsYield: 0,    volatility: 0.18, sector: "commodity" },
    ],
    correlationMatrix: [
      [1, 0.3, 0.2, 0.1, 0.2, 0.1],
      [0.3, 1, 0.5, 0.2, 0.4, 0.1],
      [0.2, 0.5, 1, 0.2, 0.6, 0.2],
      [0.1, 0.2, 0.2, 1, 0.2, 0.1],
      [0.2, 0.4, 0.6, 0.2, 1, 0.2],
      [0.1, 0.1, 0.2, 0.1, 0.2, 1],
    ],
    macro: {
      vix: 15,
      yieldSpread: 0.5,
      creditSpread: 1.2,
      move: 100,
      dxyTrend: 0,
      btcVol: 0.55,
      m2Growth: 3.0,
    },
    totalPortfolioValue: 10000,
    ...overrides,
  };
}

describe("G5 smoke — engine outputs finitos y válidos", () => {
  test("runOlympusEngine: allocations finitas y en rango", () => {
    const r = runOlympusEngine(engineInput());
    expect(r.allocations.length).toBeGreaterThan(0);

    const sum = r.allocations.reduce((acc, a) => acc + a.finalAllocation, 0);
    for (const a of r.allocations) {
      expect(isFinite(a.finalAllocation), `finalAllocation no finito para ${a.name}`).toBe(true);
      expect(a.finalAllocation).toBeGreaterThanOrEqual(0);
      expect(a.finalAllocation).toBeLessThanOrEqual(1.01);
    }
    expect(isFinite(sum)).toBe(true);
    expect(sum).toBeCloseTo(r.totalInvested ?? r.totalAllocation, 1);

    // Valores agregados finitos
    for (const v of [r.totalAllocation, r.totalInvested, r.volTargetMultiplier, r.tailRiskOverlay, r.correlationPenalty]) {
      expect(isFinite(v), "valor agregado no finito").toBe(true);
    }
  });

  test("runOlympusEngine: NaN en un activo no contagia al resto (sanitización)", () => {
    // FIX-R4.4b: un returns12m=NaN no debe producir allocations=NaN en cadena.
    const input = engineInput();
    input.assets[2].returns12m = NaN;
    const r = runOlympusEngine(input);
    for (const a of r.allocations) {
      expect(isFinite(a.finalAllocation), `NaN contagió a ${a.name}`).toBe(true);
    }
    expect(isFinite(r.totalInvested)).toBe(true);
  });

  test("detectCycleTops: multiplier y trimPct finitos en rango", () => {
    const input: CycleTopInputs = {
      bondYield10y: 4.0,
      mvrvRatio: 3.5,
      mvrvZScore: 6.5,
      puellMultiple: 4.0,
      btcRsiWeekly: 82,
      uraniumSpotPrice: 95,
      uraniumLTPrice: 86,
      soxRsiWeekly: 83,
      wlgRsiWeekly: 80,
      wlgPERatio: 19.1,
      wlgEpsGrowth: 38,
      emxcRsiWeekly: 78,
      dxy: 108,
      creditSpread: 1.2,
    };
    const out = detectCycleTops(input);
    expect(out.signals.length).toBeGreaterThan(0);
    for (const s of out.signals) {
      expect(isFinite(s.allocationMultiplier), `${s.asset} multiplier no finito`).toBe(true);
      expect(s.allocationMultiplier).toBeGreaterThanOrEqual(0);
      expect(s.allocationMultiplier).toBeLessThanOrEqual(1);
      expect(isFinite(s.trimPct), `${s.asset} trimPct no finito`).toBe(true);
      expect(s.trimPct).toBeGreaterThanOrEqual(0);
      expect(s.trimPct).toBeLessThanOrEqual(100);
      expect(typeof s.shouldTrim).toBe("boolean");
    }
  });

  test("detectCycleTops: input vacío (solo bondYield10y) no produce NaN", () => {
    const out = detectCycleTops({ bondYield10y: 4.0 });
    for (const s of out.signals) {
      expect(isFinite(s.allocationMultiplier)).toBe(true);
      expect(isFinite(s.trimPct)).toBe(true);
    }
  });

  test("detectCycleBottoms: opportunityScore y attackMultiplier finitos", () => {
    const out = detectCycleBottoms({ bondYield10y: 4.0, mvrvRatio: 1.2, uraniumSpotPrice: 40, uraniumLTPrice: 90 });
    expect(out.signals.length).toBeGreaterThan(0);
    for (const s of out.signals) {
      expect(isFinite(s.opportunityScore), `${s.asset} opportunityScore no finito`).toBe(true);
      expect(s.opportunityScore).toBeGreaterThanOrEqual(0);
      expect(s.opportunityScore).toBeLessThanOrEqual(100);
      expect(isFinite(s.attackMultiplier), `${s.asset} attackMultiplier no finito`).toBe(true);
    }
    expect(isFinite(out.maxOpportunityScore)).toBe(true);
  });

  test("computeAllocation: pesos finitos y suman ~1", () => {
    const r = computeAllocation({
      regime: "EXPANSION",
      vix: 15,
      tacticalWinRate: 0.6,
      tacticalConsecLosses: 1,
      olympusDrawdown: 0.05,
      tacticalDrawdown: 0.08,
      totalCapital: 20000,
      baseRiskPct: 0.01,
      defensiveLiquidity: 10000,
    });
    expect(isFinite(r.olympusWeight)).toBe(true);
    expect(isFinite(r.tacticalWeight)).toBe(true);
    expect(isFinite(r.riskMultiplier)).toBe(true);
    expect(r.olympusWeight + r.tacticalWeight).toBeCloseTo(1, 5);
    expect(isFinite(r.olympusEur)).toBe(true);
    expect(isFinite(r.tacticalEur)).toBe(true);
  });
});
