// FASE 3B · CORRECCIÓN 3 (T6-1)
//  BTC_CYCLE_OVERRIDE respeta BTC_TOTAL_GATE (0.337).
import { describe, test, expect } from "vitest";
import { computeSmartDCA } from "../core/dca/smartDCA";
import type { SmartDCAInput } from "../core/dca/smartDCA";

function baseInput(overrides: Partial<SmartDCAInput> = {}): SmartDCAInput {
  return {
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
    ...overrides,
  };
}
const crisisOverride = (o: Partial<SmartDCAInput> = {}) => baseInput({
  btcRsi: 30, btcZScore: -2.0, btcMomentum1m: -0.15, btcDominance: 60, mvrvRatio: 1.4,
  regime: "CRISIS", regimePenalty: 0.40, ...o,
});

describe("CORRECCIÓN 3 (T6-1) — el override respeta BTC_TOTAL_GATE", () => {
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
});
