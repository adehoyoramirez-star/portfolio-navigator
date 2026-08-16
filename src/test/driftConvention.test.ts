// ============================================================
// src/test/driftConvention.test.ts
// Tests de regresión para la convención drift OPUESTA entre
// rebalancer.ts (current − target) y smartDCA.ts (target − current).
// FIX-FORENSIC-H5.
// ============================================================
import { describe, test, expect } from "vitest";
import { computeRebalanceSuggestions } from "../core/portfolio/rebalancer";
import { buildAllocations } from "../core/dca/smartDCA";

describe("H-5 — convención drift OPUESTA rebalancer vs smartDCA", () => {
  test("rebalancer: drift = current − target (infraponderado → NEGATIVO)", () => {
    const assets = [
      { ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 1, targetAllocation: 0.30 },
    ];
    // currentValue = 100, totalPortfolioValue = 1000 → currentPct = 0.10
    // drift = 0.10 - 0.30 = -0.20 (infraponderado, NEGATIVO)
    const out = computeRebalanceSuggestions(assets, 500, 1000, 0.02, []);
    expect(out.buySuggestions.length).toBeGreaterThan(0);
    expect(out.buySuggestions[0].drift).toBeCloseTo(-0.20, 6);
  });

  test("rebalancer: sobreponderado con techo → drift POSITIVO y SELL", () => {
    const assets = [
      { ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 5, targetAllocation: 0.20 },
    ];
    // currentValue = 500, totalPortfolioValue = 1000 → currentPct = 0.50
    // drift = 0.50 - 0.20 = +0.30 (sobreponderado, POSITIVO)
    const out = computeRebalanceSuggestions(assets, 0, 1000, 0.02, [{
      asset: "Bitcoin", ticker: "BTC-EUR", allocationMultiplier: 0.5,
      zone: "CAUTION" as const, reason: "test", indicator: "RSI", indicatorValue: "70",
      shouldTrim: true, trimPct: 30,
    }]);
    expect(out.sellSuggestions.length).toBeGreaterThan(0);
    expect(out.sellSuggestions[0].drift).toBeCloseTo(0.30, 6);
  });

  test("smartDCA: drift = target − current (infraponderado → POSITIVO)", () => {
    const assets = [{ ticker: "BTC-EUR", name: "Bitcoin", finalAllocation: 0.30, price: 100 }];
    const current = new Map<string, number>([["BTC-EUR", 0.10]]);
    const out = buildAllocations(500, assets, "test", new Set(), current, false, 1000, new Map());
    const btc = out.find(a => a.ticker === "BTC-EUR");
    expect(btc).toBeDefined();
    // drift = 0.30 - 0.10 = +0.20 (infraponderado, POSITIVO)
    expect(btc!.drift).toBeCloseTo(0.20, 6);
  });

  test("REGRESIÓN H-5: mismo escenario infraponderado → signos OPUESTOS", () => {
    // Mismo caso: current 10%, target 30% (infraponderado 20pp)
    const rebalAssets = [
      { ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 1, targetAllocation: 0.30 },
    ];
    const rebalOut = computeRebalanceSuggestions(rebalAssets, 500, 1000, 0.02, []);
    const rebalDrift = rebalOut.buySuggestions[0]!.drift;

    const dcaAssets = [{ ticker: "BTC-EUR", name: "Bitcoin", finalAllocation: 0.30, price: 100 }];
    const current = new Map<string, number>([["BTC-EUR", 0.10]]);
    const dcaOut = buildAllocations(500, dcaAssets, "test", new Set(), current, false, 1000, new Map());
    const dcaDrift = dcaOut.find(a => a.ticker === "BTC-EUR")!.drift!;

    // Convención opuesta: mismo caso, signos invertidos
    expect(rebalDrift).toBeCloseTo(-0.20, 6);
    expect(dcaDrift).toBeCloseTo(0.20, 6);
    expect(Math.sign(rebalDrift)).toBe(-1);
    expect(Math.sign(dcaDrift)).toBe(1);
  });
});

describe("OVERWEIGHT TRIM — recorte institucional de sobrepeso (FIX-OVERWEIGHT-TRIM)", () => {
  test("sobreponderado SIN techo ni suelo → SELL hacia target", () => {
    const assets = [
      { ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 5, targetAllocation: 0.20 },
    ];
    // currentPct 0.50, target 0.20 → drift +0.30 (sobreponderado)
    const out = computeRebalanceSuggestions(assets, 0, 1000, 0.02, [], []);
    expect(out.sellSuggestions.length).toBe(1);
    const sell = out.sellSuggestions[0]!;
    expect(sell.ticker).toBe("BTC-EUR");
    // exceso sobre target = 500 - 200 = 300 → 3 acciones
    expect(sell.sharesToSell).toBeCloseTo(3, 5);
    expect(sell.proceedsIfSold).toBeCloseTo(300, 5);
  });

  test("sobreponderado CON suelo EXTREME → solo recorta exceso sobre floor +5pp", () => {
    const assets = [
      { ticker: "BTC-EUR", name: "Bitcoin", price: 100, shares: 5, targetAllocation: 0.20 },
    ];
    const out = computeRebalanceSuggestions(assets, 0, 1000, 0.02, [], [
      { ticker: "BTC-EUR", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" },
    ]);
    expect(out.sellSuggestions.length).toBe(1);
    const sell = out.sellSuggestions[0]!;
    // floor +5pp → allowedValue = (0.20+0.05)*1000 = 250 → exceso 250 → 2.5 acciones
    expect(sell.sharesToSell).toBeCloseTo(2.5, 5);
    expect(sell.proceedsIfSold).toBeCloseTo(250, 5);
  });

  test("sobreponderado dentro del floor del suelo → NO vender", () => {
    const assets = [
      { ticker: "URNU.DE", name: "Uranium", price: 10, shares: 24, targetAllocation: 0.20 },
    ];
    // currentValue 240, totalPortfolioValue 1000 → currentPct 0.24, drift +0.04
    // floor EXTREME +5pp → 0.04 ≤ 0.05 → dentro del rango permitido
    const out = computeRebalanceSuggestions(assets, 0, 1000, 0.02, [], [
      { ticker: "URNU.DE", attackMultiplier: 2.0, shouldAccumulate: true, zone: "EXTREME" },
    ]);
    expect(out.sellSuggestions.length).toBe(0);
  });
});
