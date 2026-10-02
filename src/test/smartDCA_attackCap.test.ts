// FASE 3B · CORRECCIÓN 4 (T6-2)
//  Una compra de ataque no puede dejar el peso del activo por encima de target + 5 pp
//  (suelo EXTREME), sin multiplicar el cap por bottomMul.
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
    ],
    ...overrides,
  };
}

describe("CORRECCIÓN 4 (T6-2) — tope target+5 pp sin ×bottomMul", () => {
  const TPV = 100_000;
  const atTarget = () => baseInput({
    totalPortfolioValueEUR: TPV,
    olympusAvailableCash: 20_000,
    motorAllocations: [
      { name: "Bitcoin", ticker: "BTC-EUR", finalAllocation: 0.20, price: 60000 },
      { name: "MSCI World", ticker: "0P00000WLG.F", finalAllocation: 0.20, price: 75 },
    ],
    currentAllocations: [
      { ticker: "BTC-EUR", name: "Bitcoin", currentWeight: 0.20 },
      { ticker: "0P00000WLG.F", name: "MSCI World", currentWeight: 0.20 },
    ],
    cycleBottomSignals: [{ ticker: "BTC-EUR", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" }],
  });

  test("EXTREME con activo EN target: la compra no supera target + 5 pp", () => {
    const r = computeSmartDCA(atTarget());
    const btc = r.allocationByAsset.find(a => a.ticker === "BTC-EUR")!;
    const postWeight = (0.20 * TPV + btc.actualCost) / TPV;
    expect(postWeight).toBeLessThanOrEqual(0.25 + 1e-6);
  });

  test("sin señal de suelo (activo en target) → no compra", () => {
    const r = computeSmartDCA(baseInput({
      totalPortfolioValueEUR: TPV, olympusAvailableCash: 20_000,
      motorAllocations: [{ name: "Bitcoin", ticker: "BTC-EUR", finalAllocation: 0.20, price: 60000 }],
      currentAllocations: [{ ticker: "BTC-EUR", name: "Bitcoin", currentWeight: 0.20 }],
    }));
    const btc = r.allocationByAsset.find(a => a.ticker === "BTC-EUR");
    expect(btc?.actualCost ?? 0).toBe(0);
  });
});
