// ============================================================
// src/test/satelliteInvariant.test.ts
// Invariantes del satélite BTC (PRE-IMPLEMENTATION AUDIT, Rounds 8-9).
// Verifica que la fórmula composite centralizada (composite.ts) cumple:
//   1. btcSat = (100 − olympusPct)/100 en los límites.
//   2. INVARIANTE 30% BTC total: sat + (1−sat) × BTC_motor ≈ 30%
//      (banda ±4pp sobre la rejilla plausible olympusPct ∈ [78,82],
//       BTC_motor ∈ [11%,15%]; nominal 80/20 + 13% → 30,4%).
//   3. Σ compositeAlloc = 100% para cualquier engineAlloc que sume 1.
//   4. Paridad exacta con la fórmula inline histórica (los 7 sitios).
// ============================================================
import { describe, test, expect } from "vitest";
import { btcSatPct, olyPct, compositeTarget, btcTotalExposure } from "../core/backtest/composite";

describe("satélite BTC — invariantes (Rounds 8-9)", () => {
  test("btcSatPct: límites y valores clave", () => {
    expect(btcSatPct(100)).toBeCloseTo(0, 10);
    expect(btcSatPct(0)).toBeCloseTo(1, 10);
    expect(btcSatPct(80)).toBeCloseTo(0.2, 10);
    expect(btcSatPct(78)).toBeCloseTo(0.22, 10);
    expect(btcSatPct(82)).toBeCloseTo(0.18, 10);
    expect(olyPct(80)).toBeCloseTo(0.8, 10);
  });

  test("INVARIANTE 30% BTC total: |total − 0.30| ≤ 0.04 en la rejilla [78..82] × [0.11..0.15]", () => {
    let min = Infinity, max = -Infinity;
    for (const olympusPct of [78, 79, 80, 81, 82]) {
      for (const motorBtc of [0.11, 0.13, 0.15]) {
        const total = btcTotalExposure(olympusPct, motorBtc);
        expect(Math.abs(total - 0.30)).toBeLessThanOrEqual(0.04);
        min = Math.min(min, total);
        max = Math.max(max, total);
      }
    }
    // rango real de la rejilla: [27,0%, 33,7%]
    expect(min).toBeGreaterThanOrEqual(0.27);
    expect(max).toBeLessThanOrEqual(0.34);
    // caso nominal: olympusPct 80 + motor 13% → 30,4% (auditoría Round 9)
    expect(btcTotalExposure(80, 0.13)).toBeCloseTo(0.304, 3);
  });

  test("Σ compositeTarget = 100% para cualquier engineAlloc que sume 1", () => {
    const cases = [
      { btc: 0.10, rest: 0.90 },
      { btc: 0.20, rest: 0.80 },
      { btc: 0.00, rest: 1.00 },
      { btc: 0.35, rest: 0.65 },
    ];
    for (const { btc, rest } of cases) {
      for (const olympusPct of [70, 78, 80, 100]) {
        const sum = compositeTarget(btc, olympusPct, true) + compositeTarget(rest, olympusPct, false);
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });

  test("paridad exacta con la fórmula inline histórica (los 7 sitios)", () => {
    for (const engineAlloc of [0.001, 0.05, 0.13, 0.35, 0.9]) {
      for (const olympusPct of [70, 80, 100]) {
        const inline = (isBtc: boolean) =>
          isBtc
            ? engineAlloc * (olympusPct / 100) + (100 - olympusPct) / 100
            : engineAlloc * (olympusPct / 100);
        expect(compositeTarget(engineAlloc, olympusPct, true)).toBeCloseTo(inline(true), 12);
        expect(compositeTarget(engineAlloc, olympusPct, false)).toBeCloseTo(inline(false), 12);
      }
    }
  });

  test("el satélite se suma SOLO a BTC: el resto del motor se escala, no se duplica", () => {
    // motor: BTC 13%, otros 87% → composite 80/20: BTC = 0.13×0.8 + 0.2 = 0.304;
    // otros = 0.87×0.8 = 0.696 → suma 1
    const btc = compositeTarget(0.13, 80, true);
    const otros = compositeTarget(0.87, 80, false);
    expect(btc).toBeCloseTo(0.304, 6);
    expect(otros).toBeCloseTo(0.696, 6);
    expect(btc + otros).toBeCloseTo(1, 6);
  });
});
