// ============================================================
// src/test/compositeMetrics.test.ts
// Tests de regresión para el alineamiento BTC del Composite Strategy
// (FIX-FORENSIC-COMPOSITE).
// ============================================================
import { describe, test, expect } from "vitest";
import { computeCompositeMetrics } from "../core/backtest/compositeMetrics";

describe("computeCompositeMetrics — alineación BTC (FIX-FORENSIC-COMPOSITE)", () => {
  test("regresión: BTC crash en la pre-ventana (primeros 252 días) NO contamina el composite", () => {
    // 252 días de crash 100→50 (deben quedar FUERA de la ventana alineada) + 1001 días planos en 50.
    // (FIX-ALIGN-1D: con btcStart = btcLen − recLen − 1 hace falta un día plano extra para que el
    // primer retorno de la ventana no sea el último día del crash.)
    const btcPrices: number[] = [];
    for (let i = 0; i < 252; i++) btcPrices.push(100 - (50 * i) / 251); // 100 → 50
    for (let i = 0; i < 1001; i++) btcPrices.push(50); // plano

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

  test("blend 80/20 (satélite 20%, default auditado): composite = 0.8 × engine + 0.2 × BTC con rebalanceo 21d", () => {
    // engine crece 1%/día compuesto; BTC plano. Con rebalanceo DIARIO sería
    // exactamente 1.008^365; con 21d el peso del motor deriva al alza entre
    // rebalances → el valor final queda entre 1.008^365 y 1.01^365.
    const olympusDaily: number[] = [];
    for (let i = 0; i < 365; i++) olympusDaily.push(10000 * Math.pow(1.01, i + 1));
    // 252 días de pre-ventana (crash irreal) + 365 planos: la alineación usa los últimos 365
    const btcPrices = Array(365 + 252).fill(100);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });
    expect(m.finalValue).toBeGreaterThan(10000 * Math.pow(1.008, 365));
    expect(m.finalValue).toBeLessThan(10000 * Math.pow(1.01, 365));
    expect(m.maxDrawdown).toBeCloseTo(0, 3);
  });

  test("rebalanceo 21d: los pesos derivan entre rebalances y se resetean al target cada 21 días", () => {
    // engine +1%/día compuesto durante 25 días (incluye un reset en el día 21); BTC plano
    const n = 25;
    const olympusDaily: number[] = [];
    for (let i = 0; i < n; i++) olympusDaily.push(10000 * Math.pow(1.01, i + 1));
    const btcPrices = Array(n + 252).fill(100);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });

    // Referencia explícita de la convención: wOly deriva con el retorno del motor
    // y se resetea a 0.8 cada 21 días (día 0 = target inicial, sin ejecución en t+1)
    let w = 0.8;
    let v = 10000;
    for (let d = 0; d < n; d++) {
      if (d > 0 && d % 21 === 0) w = 0.8;
      const r = w * 0.01;
      v *= 1 + r;
      w = (w * 1.01) / (1 + r);
    }
    expect(m.finalValue).toBeCloseTo(v, 0);
    // El drift (sin rebalancear a diario) aporta valor frente al blend diario
    expect(m.finalValue).toBeGreaterThan(10000 * Math.pow(1.008, n));
  });

  test("blend 80/20 con BTC moviéndose: el satélite aporta exactamente el 20% del retorno BTC", () => {
    // engine plano (ret 0); BTC sube +10% en un solo día dentro de la ventana alineada
    const olympusDaily = Array(100).fill(10000);
    const btcPrices: number[] = [];
    for (let i = 0; i < 50; i++) btcPrices.push(100);
    btcPrices.push(110); // +10%
    for (let i = 0; i < 50; i++) btcPrices.push(110);
    const m = computeCompositeMetrics({ olympusDailyValues: olympusDaily, btcPrices, olympusPct: 80, initialCapital: 10000 });
    // retorno composite = 0.2 × 10% = 2% → 10000 × 1.02
    expect(m.finalValue).toBeCloseTo(10200, 0);
    expect(m.maxDrawdown).toBeCloseTo(0, 6);
  });
});
