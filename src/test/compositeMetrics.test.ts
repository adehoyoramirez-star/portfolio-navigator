// ============================================================
// src/test/compositeMetrics.test.ts
// Tests de regresión para el alineamiento BTC del Composite Strategy
// (FIX-FORENSIC-COMPOSITE).
// ============================================================
import { describe, test, expect } from "vitest";
import { computeCompositeMetrics } from "../core/backtest/compositeMetrics";

describe("computeCompositeMetrics — alineación BTC (FIX-FORENSIC-COMPOSITE)", () => {
  test("regresión: BTC crash en la pre-ventana (primeros 252 días) NO contamina el composite", () => {
    // 252 días de crash 100→50 (deben quedar FUERA de la ventana alineada) + 1000 días planos en 50
    const btcPrices: number[] = [];
    for (let i = 0; i < 252; i++) btcPrices.push(100 - (50 * i) / 251); // 100 → 50
    for (let i = 0; i < 1000; i++) btcPrices.push(50); // plano

    // Olympus plano: 1000 días (recLen = 1000)
    const olympusDaily = Array(1000).fill(10000);

    // 100% BTC (olympusPct = 0)
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 0, initialCapital: 10000 });

    // btcStart = 1252 - 1000 = 252 → usa solo la zona plana → retorno 0, sin drawdown.
    // Con el bug (btcStart=0) habría cogido el crash → maxDD ≈ -50%.
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
    expect(m.finalValue).toBeCloseTo(10000, 0);
  });

  test("si el crash está DENTRO de la ventana alineada, sí se refleja en el drawdown", () => {
    // 1000 días planos + 252 días de crash al final (dentro de la ventana)
    const btcPrices: number[] = [];
    for (let i = 0; i < 1000; i++) btcPrices.push(100);
    for (let i = 0; i < 252; i++) btcPrices.push(100 - (50 * i) / 251); // 100 → 50

    const olympusDaily = Array(1000).fill(10000);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 0, initialCapital: 10000 });

    // btcStart = 1252 - 1000 = 252 → incluye el crash final → drawdown negativo
    expect(m.maxDrawdown).toBeLessThan(0);
  });

  test("blend 70/30 con Olympus plano y BTC plano → sin variación", () => {
    const btcPrices = Array(752).fill(100);
    const olympusDaily = Array(500).fill(10000);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 70, initialCapital: 10000 });
    expect(m.finalValue).toBeCloseTo(10000, 6);
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
  });
});
