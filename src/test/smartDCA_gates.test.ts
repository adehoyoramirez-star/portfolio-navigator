// FASE 3B · CORRECCIÓN 3 (T6-1)
//  BTC_CYCLE_OVERRIDE respeta BTC_TOTAL_GATE (0.337).
import { describe, test, expect } from "vitest";
import { computeSmartDCA } from "../core/dca/smartDCA";
import type { SmartDCAInput } from "../core/dca/smartDCA";

function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  const input: SmartDCAInput = {
    btcRsi: 50, btcZScore: 0, btcMomentum1m: 0, btcDominance: 50, mvrvRatio: 2.0,
    regime: "EXPANSION", regimePenalty: 0.80, volTargetMultiplier: 1.0,
    tailRiskActive: false, tailRiskOverlay: 1.0, killSwitchLevel: 0, recoveryCyclesRemaining: 0,
    olympusAvailableCash: 1000, tacticalAvailableCash: 500, accumulatedDefensiveLiquidity: 0,
    motorAllocations: [
      { name: "Bitcoin", ticker: "BTC-EUR", finalAllocation: 0.20, price: 60000 },
      { name: "MSCI World", ticker: "0P00000WLG.F", finalAllocation: 0.30, price: 75 },
      { name: "Uranio", ticker: "URNU.DE", finalAllocation: 0.05, price: 28 },
      { name: "E.M.", ticker: "EMXC.DE", finalAllocation: 0.10, price: 30 },
      { name: "Gold", ticker: "PPFB.DE", finalAllocation: 0.15, price: 70 },
      { name: "Value", ticker: "VVSM.DE", finalAllocation: 0.10, price: 55 },
    ],
    totalPortfolioValueEUR: 100_000,
    ...overrides,
  };
  if (!overrides.currentAllocations) input.currentAllocations = input.motorAllocations.map(a => ({ ticker: a.ticker, name: a.name, currentWeight: a.ticker === "BTC-EUR" ? 0.10 : 0 }));
  return input;
}
const crisisOverride = (o: Partial<SmartDCAInput> = {}) => baseInput({
  btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15, btcDominance: 60, mvrvRatio: 1.4,
  regime: "CRISIS", regimePenalty: 0.40, ...o,
});

describe("CORRECCIÓN 3 (T6-1) — el override respeta BTC_TOTAL_GATE", () => {
  test("CRISIS + 2 señales → no override", () => {
    const r = computeSmartDCA(crisisOverride({ btcMomentum1m: 0, btcDominance: 50, mvrvRatio: 2.0 }));
    expect(r.action).toBe("BLOCK_CRISIS");
  });

  test("CRISIS + 3 señales → PROBE no puede activar BTC override", () => {
    const r = computeSmartDCA(crisisOverride({ btcDominance: 50 }));
    expect(r.action).toBe("BLOCK_CRISIS");
  });

  test("CRISIS + 4 señales + BTC_TOTAL 40% (≥0.337) → WAIT (antes compraba)", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.40 }));
    expect(r.action).toBe("WAIT");
    expect(r.totalCashToInvest).toBe(0);
  });

  test("CRISIS + 4 señales + BTC_TOTAL 30% (<0.337) → sigue comprando BTC", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30 }));
    expect(r.action).toBe("BTC_CYCLE_OVERRIDE");
    expect(r.totalCashToInvest).toBeGreaterThan(0);
  });

  test("sin btcTotalComposite (undefined) → comportamiento previo intacto", () => {
    const r = computeSmartDCA(crisisOverride());
    expect(r.action).toBe("BTC_CYCLE_OVERRIDE");
  });

  test("staleDataBlock sigue bloqueando el override", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30, staleDataBlock: true }));
    expect(r.action).toBe("BLOCK_STALE_DATA");
  });

  test("killSwitchLevel ≥4 sigue bloqueando el override", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30, tailRiskActive: true, tailRiskOverlay: 0.5, killSwitchLevel: 4 }));
    expect(r.action).toBe("BLOCK_TAIL_RISK");
  });

  test("BTC sobreponderado sin bottom EXTREME → override sin compra", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30, currentAllocations: [
      { ticker: "BTC-EUR", name: "Bitcoin", currentWeight: 0.23 },
    ] }));
    expect(r.action).toBe("WAIT");
    expect(r.totalCashToInvest).toBe(0);
  });

  test("cycle-top DANGER/EXTREME mantiene el veto individual del override", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30, cycleTopSignals: [
      { ticker: "BTC-EUR", shouldTrim: true, zone: "DANGER" },
    ] }));
    expect(r.action).toBe("WAIT");
    expect(r.totalCashToInvest).toBe(0);
  });

  test("sin NAV o peso actual no se autoriza la asignación del override", () => {
    const r = computeSmartDCA(crisisOverride({ btcTotalComposite: 0.30, totalPortfolioValueEUR: undefined, currentAllocations: undefined }));
    expect(r.action).toBe("WAIT");
    expect(r.totalCashToInvest).toBe(0);
  });
});
