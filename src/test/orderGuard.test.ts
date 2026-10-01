// ============================================================
// FIX-ORDER-GUARD — Tests de la capa de seguridad de ejecución
// ============================================================
// Comportamiento pinnado (FIX-CLIFF-CREDIT-01 · Fases 4/5/8):
//   1. ORDER sigue siendo target-driven: deficit = target·NAV − actual.
//   2. BUYs truncados a min(deficit, 25% NAV, €2.500) — general a TODOS los
//      activos, sin excepciones URNU.
//   3. El déficit no ejecutado NO se elimina: queda en pendingDeficit.
//   4. Los SELLs (trim de ciclo / sobrepeso) NO tienen cap.
//   5. No es un segundo motor: sin cash suficiente, el guard no crea órdenes.

import { describe, test, expect } from "vitest";
import { computeRebalanceSuggestions, type RebalanceAsset } from "../core/portfolio/rebalancer";
import { ORDER_GUARD_CONFIG } from "../core/config/engineConfig";

const MAX_W = ORDER_GUARD_CONFIG.MAX_WEIGHT_INCREMENT_PER_REBALANCE;
const MAX_V = ORDER_GUARD_CONFIG.MAX_ORDER_VALUE;

// NAV invertido = 10.000€ (el cash disponible se pasa aparte en cada test).
const NAV = 10_000;

function asset(partial: Partial<RebalanceAsset>): RebalanceAsset {
  return { ticker: "X", name: "X", price: 10, shares: 0, targetAllocation: 0, ...partial };
}

describe("FIX-ORDER-GUARD — target-driven intacto (sin guard cuando el déficit es pequeño)", () => {
  test("déficit < caps → orden exactamente igual que antes del guard", () => {
    // URNU: actual 0%, target 10% → deficit = 0.10·(10.000+2.000) = €1.200 → 120 un.
    // Caja €2.000 ≥ €1.200 → orden completa, sin pendiente.
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "URNU.DE", name: "Uranium", price: 10, shares: 0, targetAllocation: 0.10 })],
      2_000, NAV, 0.02, [], []
    );
    expect(out.buySuggestions).toHaveLength(1);
    expect(out.buySuggestions[0].sharesToBuy).toBe(120);
    expect(out.buySuggestions[0].cost).toBeCloseTo(1200, 6);
    expect(out.buySuggestions[0].pendingDeficit).toBeUndefined();
  });
});

describe("FIX-ORDER-GUARD — cap de incremento de peso por rebalanceo", () => {
  test("URNU 10% → target 20%: deficit < caps → sin truncado (fórmula intacta)", () => {
    // Fórmula ORIGINAL intacta: deficit = target%·(NAV+cash) − actual.
    // NAV=10.000, cash=2.000 → deficit = 0.20·12.000 − 1.000 = €1.400 < caps.
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "URNU.DE", name: "Uranium", price: 10, shares: 100, targetAllocation: 0.20 })],
      2_000, NAV, 0.02, [], []
    );
    expect(out.buySuggestions).toHaveLength(1);
    expect(out.buySuggestions[0].cost).toBeCloseTo(1400, 6);
    expect(out.buySuggestions[0].pendingDeficit).toBeUndefined();
  });

  test("salto brusco de target (10% → 60%): orden truncada al cap y gap pendiente", () => {
    // NAV=10.000, cash=3.000 → deficit = 0.60·13.000 − 1.000 = €6.800.
    // Guard: min(raw=3.000, 25%·13.000=3.250, €2.500) = €2.500 → 250 shares.
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "URNU.DE", name: "Uranium", price: 10, shares: 100, targetAllocation: 0.60 })],
      3_000, NAV, 0.02, [], []
    );
    expect(out.buySuggestions).toHaveLength(1);
    const buy = out.buySuggestions[0];
    expect(buy.cost).toBeLessThanOrEqual(Math.min(MAX_W * (NAV + 3_000), MAX_V) + 1e-6);
    expect(buy.sharesToBuy).toBe(250); // floor(2500/10)
    // El resto NO se elimina: déficit pendiente (€6.800 − €2.500 = €4.300).
    expect(buy.pendingDeficit).toBeCloseTo(4300, 6);
  });
});

describe("FIX-ORDER-GUARD — cap de valor por orden", () => {
  test("raw €4.000 sobre NAV pequeño → truncada por el cap que actúe primero", () => {
    const invertedNav = 8_000;
    // Actual 0%, target 50% de NAV total (8k+4k=12k)... deficit usa targetPct·totalValue:
    // totalValue = 8.000+4.000 = 12.000 → deficit = €6.000. raw = min(6000, 6000, 4000 cash) = 4000.
    // Guard: min(4000, 25%·12k=3000, 2500) = €2.500 → 250 shares a €10.
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "VVSM.DE", name: "Semis", price: 10, shares: 0, targetAllocation: 0.50 })],
      4_000, invertedNav, 0.02, [], []
    );
    const buy = out.buySuggestions[0];
    expect(buy).toBeDefined();
    expect(buy.cost).toBeLessThanOrEqual(MAX_V + 1e-6);
    expect(buy.pendingDeficit).toBeCloseTo(6000 - buy.cost, 6);
  });
});

describe("FIX-ORDER-GUARD — general a todos los activos (sin excepciones)", () => {
  const cases: Array<{ ticker: string; name: string; price: number }> = [
    { ticker: "BTC-EUR", name: "Bitcoin", price: 50_000 },
    { ticker: "VVSM.DE", name: "Semis", price: 55 },
    { ticker: "EMXC.DE", name: "EM ex-China", price: 28 },
    { ticker: "0P00000WLG.F", name: "World Gold", price: 70 },
    { ticker: "PPFB.DE", name: "Gold", price: 72 },
    { ticker: "URNU.DE", name: "Uranium", price: 4.44 },
  ];

  test("ningún activo supera el cap de incremento de peso ni de valor", () => {
    for (const c of cases) {
      // Target 100% desde 0 → raw deficit enorme → el guard SIEMPRE trunca.
      const out = computeRebalanceSuggestions(
        [asset({ ticker: c.ticker, name: c.name, price: c.price, shares: 0, targetAllocation: 1.0 })],
        3_000, NAV, 0.02, [], []
      );
      const buy = out.buySuggestions[0];
      expect(buy, c.ticker).toBeDefined();
      expect(buy.cost, c.ticker).toBeLessThanOrEqual(Math.min(MAX_W * (NAV + 3_000), MAX_V) + 1e-6);
      expect(buy.pendingDeficit, c.ticker).toBeGreaterThan(0);
    }
  });
});

describe("FIX-ORDER-GUARD — sells sin cap", () => {
  test("trim de ciclo sobre posición grande NO se trunca", () => {
    // WLG 50% del NAV con señal EXTREME de trim → venta grande permitida.
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "0P00000WLG.F", name: "World", price: 10, shares: 500, targetAllocation: 0.10 })],
      0, NAV, 0.02,
      [{
        asset: "World", ticker: "0P00000WLG.F", allocationMultiplier: 0.0,
        zone: "EXTREME", reason: "techo de ciclo", indicator: "RSI", indicatorValue: "95",
        shouldTrim: true, trimPct: 50,
      }],
      []
    );
    expect(out.sellSuggestions).toHaveLength(1);
    // Vende TODO el exceso sobre target (€4.000 → 400 shares) sin ningún cap.
    expect(out.sellSuggestions[0].sharesToSell).toBe(400);
    expect(out.totalProceeds).toBeCloseTo(4000, 6);
  });

  test("sobrepeso sin señal de techo tampoco se trunca", () => {
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "BTC-EUR", name: "Bitcoin", price: 10, shares: 600, targetAllocation: 0.10 })],
      0, NAV, 0.02, [], []
    );
    expect(out.sellSuggestions).toHaveLength(1);
    expect(out.sellSuggestions[0].sharesToSell).toBe(500); // recorta hasta target
  });
});

describe("FIX-ORDER-GUARD — invariante de cash", () => {
  test("el guard nunca crea órdenes sin caja disponible", () => {
    const out = computeRebalanceSuggestions(
      [asset({ ticker: "URNU.DE", name: "Uranium", price: 10, shares: 0, targetAllocation: 0.60 })],
      0, NAV, 0.02, [], []
    );
    expect(out.totalCost).toBeLessThanOrEqual(0 + 1e-6);
    expect(out.buySuggestions).toHaveLength(0);
  });
});
