// ============================================================
// src/test/detectorInvariants.test.ts
// Tier 1 (G2) — INVARIANTES de los detectores de ciclo.
// Property-based manual: grid determinista de inputs + casos edge.
// Bloqueante: cualquier invariante roto falla la suite.
// ============================================================
import { describe, test, expect } from "vitest";
import { detectCycleTops, detectCycleBottoms } from "../core/risk/cycleTopDetector";
import type { CycleTopInputs } from "../core/risk/cycleTopDetector";

const TOP_ZONES = ["SAFE", "CAUTION", "DANGER", "EXTREME"] as const;
const BOTTOM_ZONES = ["NEUTRAL", "VALUE", "OPPORTUNITY", "EXTREME"] as const;

// Grid determinista: variaciones de cada input relevante (low/mid/high/edge).
const INPUT_GRID: CycleTopInputs[] = [
  { bondYield10y: 4.0 },                                                    // mínimo (todo undefined)
  { bondYield10y: 4.0, mvrvZScore: 0, mvrvRatio: 1.0, puellMultiple: 0.5, btcRsiWeekly: 30 },
  { bondYield10y: 4.0, mvrvZScore: 3, mvrvRatio: 3.0, puellMultiple: 2.0, btcRsiWeekly: 60 },
  { bondYield10y: 4.0, mvrvZScore: 6.5, mvrvRatio: 4.5, puellMultiple: 3.0, btcRsiWeekly: 82, btcDominanceFalling: true },
  { bondYield10y: 4.0, mvrvZScore: 9, mvrvRatio: 7.5, puellMultiple: 5.5, btcRsiWeekly: 90, btcDominanceFalling: true },
  { bondYield10y: 4.0, uraniumSpotPrice: 50, uraniumLTPrice: 100 },
  { bondYield10y: 4.0, uraniumSpotPrice: 120, uraniumLTPrice: 100 },
  { bondYield10y: 4.0, uraniumSpotPrice: 180, uraniumLTPrice: 100 },
  { bondYield10y: 4.0, siaSalesYoY: 30, soxRsiWeekly: 70, soxSpyRelativeStrength: 1.0 },
  { bondYield10y: 4.0, siaSalesYoY: 104, soxRsiWeekly: 88, soxSpyRelativeStrength: 3.0 },
  { bondYield10y: 4.0, wlgRsiWeekly: 70, wlgPERatio: 19, wlgEpsGrowth: 20, creditSpread: 1.2 },
  { bondYield10y: 4.0, wlgRsiWeekly: 85, wlgPERatio: 25, wlgEpsGrowth: 3, creditSpread: 4.0 },
  { bondYield10y: 4.0, emxcRsiWeekly: 78, emxcPERatio: 15, dxy: 104 },
  { bondYield10y: 4.0, emxcRsiWeekly: 88, emxcPERatio: 22, dxy: 116 },
  { bondYield10y: 4.0, inflationBreakeven: 2.0, brentOil: 83, goldCbPurchases: 450 },
  { bondYield10y: 4.0, inflationBreakeven: 1.5, brentOil: 100, goldCbPurchases: 1100 },
  // Edge cases
  { bondYield10y: 4.0, mvrvZScore: NaN },
  { bondYield10y: 4.0, dxy: 0 },           // dato inválido (fetch fallido)
  { bondYield10y: 4.0, puellMultiple: -1 },
  { bondYield10y: 4.0, wlgPERatio: 0 },
  { bondYield10y: 4.0, mvrvZScore: Infinity },
];

describe("G2 — Invariantes Cycle Top", () => {
  test("derivación: trimPct === round((1 - multiplier) * 100) en TODO el grid", () => {
    for (const inputs of INPUT_GRID) {
      const out = detectCycleTops(inputs);
      for (const s of out.signals) {
        expect(
          s.trimPct,
          `desync trimPct en ${s.ticker} para ${JSON.stringify(inputs)}`,
        ).toBe(Math.round((1 - s.allocationMultiplier) * 100));
      }
    }
  });

  test("rango y finitud: multiplier ∈ [0,1], trimPct ∈ [0,100], sin NaN/Inf", () => {
    for (const inputs of INPUT_GRID) {
      for (const s of detectCycleTops(inputs).signals) {
        expect(Number.isFinite(s.allocationMultiplier)).toBe(true);
        expect(Number.isFinite(s.trimPct)).toBe(true);
        expect(s.allocationMultiplier).toBeGreaterThanOrEqual(0);
        expect(s.allocationMultiplier).toBeLessThanOrEqual(1);
        expect(s.trimPct).toBeGreaterThanOrEqual(0);
        expect(s.trimPct).toBeLessThanOrEqual(100);
      }
    }
  });

  test("coherencia: shouldTrim === (trimPct > 0) y zone válida", () => {
    for (const inputs of INPUT_GRID) {
      for (const s of detectCycleTops(inputs).signals) {
        expect(s.shouldTrim).toBe(s.trimPct > 0);
        expect(TOP_ZONES).toContain(s.zone);
      }
    }
  });

  test("monotonicidad BTC: más MVRV Z → multiplier no creciente", () => {
    const low = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 1.0 }).signals.find(s => s.ticker === "BTC-EUR")!;
    const mid = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 6.0 }).signals.find(s => s.ticker === "BTC-EUR")!;
    const high = detectCycleTops({ bondYield10y: 4.0, mvrvZScore: 9.0 }).signals.find(s => s.ticker === "BTC-EUR")!;
    expect(low.allocationMultiplier).toBeGreaterThanOrEqual(mid.allocationMultiplier);
    expect(mid.allocationMultiplier).toBeGreaterThanOrEqual(high.allocationMultiplier);
  });

  test("monotonicidad Uranio: más ratio Spot/LT → multiplier no creciente", () => {
    const mk = (spot: number) => detectCycleTops({ bondYield10y: 4.0, uraniumSpotPrice: spot, uraniumLTPrice: 100 })
      .signals.find(s => s.ticker === "URNU.DE")!;
    expect(mk(90).allocationMultiplier).toBeGreaterThanOrEqual(mk(115).allocationMultiplier);
    expect(mk(115).allocationMultiplier).toBeGreaterThanOrEqual(mk(160).allocationMultiplier);
  });

  test("6 señales siempre presentes y sin crash", () => {
    for (const inputs of INPUT_GRID) {
      expect(detectCycleTops(inputs).signals.length).toBe(6);
    }
  });

  test("FIX-RSI-BOUNDARY: RSI=100 no se invalida (colapso trimPct)", () => {
    // Antes del fix, isValidReading(100, 0, 100) usaba `v < max` → 100 < 100 = false
    // → la lectura se caía y el trimPct colapsaba a 0%. RSI=100 es legítimo.
    const semis = detectCycleTops({ bondYield10y: 4.0, soxRsiWeekly: 100, soxSpyRelativeStrength: 0 })
      .signals.find(s => s.ticker === "VVSM.DE")!;
    expect(semis.trimPct).toBeGreaterThan(0);

    const btc = detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: 100 })
      .signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.trimPct).toBeGreaterThan(0);

    // Y el extremo inferior sigue siendo válido (RSI=0 no debe invalidarse en el top)
    const btcLow = detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: 0 })
      .signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btcLow.trimPct).toBe(0);
  });

  test("FIX-RSI-CLAMP: RSI>100 se clampa a [0,100] (no colapso silencioso a SAFE)", () => {
    // Antes del clamp, isValidReading(100.3, 0, 100) invalidaba → topSignals
    // colapsaba (55%→0%) y el panel mostraba SAFE con un dato basura.
    // clampRSI lleva 100.3 → 100 → sobrecompra extrema (+2 → trim 55%).
    const btc = detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: 100.3 })
      .signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btc.trimPct).toBe(55);

    const semis = detectCycleTops({ bondYield10y: 4.0, soxRsiWeekly: 100.3 })
      .signals.find(s => s.ticker === "VVSM.DE")!;
    expect(semis.trimPct).toBe(55);

    const emxc = detectCycleTops({ bondYield10y: 4.0, emxcRsiWeekly: 100.3 })
      .signals.find(s => s.ticker === "EMXC.DE")!;
    expect(emxc.trimPct).toBe(55);

    // RSI negativo (también imposible) → clamp a 0 → sin señal de techo.
    const btcNeg = detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: -5 })
      .signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btcNeg.trimPct).toBe(0);

    // NaN/undefined sigue sin señal (no se inventa sobrecompra).
    const btcNaN = detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: NaN })
      .signals.find(s => s.ticker === "BTC-EUR")!;
    expect(btcNaN.trimPct).toBe(0);
  });

  test("FIX-RSI-RAMP: RSI-W BTC rampa suave [80→0, 85→2] sin cliff", () => {
    const mk = (rsi: number) => detectCycleTops({ bondYield10y: 4.0, btcRsiWeekly: rsi })
      .signals.find(s => s.ticker === "BTC-EUR")!;

    // Sin señal por debajo de 80 (no se recorta prematuramente).
    expect(mk(70).trimPct).toBe(0);
    expect(mk(80).trimPct).toBe(0);

    // Rampa intermedia 80→85: trim gradual, sin el salto 0→55pp.
    expect(mk(82).trimPct).toBe(31);
    expect(mk(84).trimPct).toBe(47);

    // Cap +2 en 85 y más allá (idéntico al comportamiento anterior).
    expect(mk(85).trimPct).toBe(55);
    expect(mk(90).trimPct).toBe(55);
  });
});

describe("G2 — Invariantes Cycle Bottom", () => {
  test("rango y finitud: opportunityScore ∈ [0,100], attackMultiplier ∈ [1,2]", () => {
    for (const inputs of INPUT_GRID) {
      for (const s of detectCycleBottoms(inputs).signals) {
        expect(Number.isFinite(s.opportunityScore)).toBe(true);
        expect(Number.isFinite(s.attackMultiplier)).toBe(true);
        expect(s.opportunityScore).toBeGreaterThanOrEqual(0);
        expect(s.opportunityScore).toBeLessThanOrEqual(100);
        expect(s.attackMultiplier).toBeGreaterThanOrEqual(1);
        expect(s.attackMultiplier).toBeLessThanOrEqual(2);
        expect(BOTTOM_ZONES).toContain(s.zone);
      }
    }
  });

  test("6 señales siempre presentes y sin crash", () => {
    for (const inputs of INPUT_GRID) {
      expect(detectCycleBottoms(inputs).signals.length).toBe(6);
    }
  });
});
