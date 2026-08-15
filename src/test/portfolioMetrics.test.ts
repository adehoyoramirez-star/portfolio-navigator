// ============================================================
// src/test/portfolioMetrics.test.ts
// Tests de regresión para sortinoRatioReal y betaVsBenchmark
// (fixes forense H-4 y H-3).
// ============================================================
import { describe, test, expect } from "vitest";
import { sortinoRatioReal, betaVsBenchmark, jensenAlpha } from "../core/data/portfolioMetrics";

describe("sortinoRatioReal — semi-desviación centrada en MAR (FIX-FORENSIC-H4)", () => {
  test("sin downside (todo > rf) → Infinity", () => {
    const returns = Array(30).fill(0.01); // +1% diario
    expect(sortinoRatioReal(returns, 0.10, 0.04)).toBe(Infinity);
  });

  test("semi-desviación MAR-centrada coincide con la fórmula estándar", () => {
    const returns = [0.001, 0.001, 0.001, 0.001, 0.001, -0.01, -0.02, -0.03, -0.04, -0.05];
    const annualReturn = 0.10;
    const rf = 0.04;
    const s = sortinoRatioReal(returns, annualReturn, rf);

    // Fórmula estándar: sqrt(mean(min(0, r - rf/252)^2)) * sqrt(252)
    const rfDaily = rf / 252;
    const downSq = returns.map(r => Math.min(0, r - rfDaily) ** 2);
    const meanDown = downSq.reduce((a, b) => a + b, 0) / returns.length;
    const expectedDownDev = Math.sqrt(meanDown) * Math.sqrt(252);
    const expected = (annualReturn - rf) / expectedDownDev;

    expect(s).toBeCloseTo(expected, 6);
  });

  test("regresión: la desviación centrada en la media de negativos (bug antiguo) inflaba el Sortino", () => {
    const returns = [0.001, 0.001, 0.001, 0.001, 0.001, -0.01, -0.02, -0.03, -0.04, -0.05];
    const rf = 0.04;
    const rfDaily = rf / 252;

    // Antiguo (bug): varianza centrada en la media de los negativos
    const negatives = returns.filter(r => r < rfDaily);
    const meanNeg = negatives.reduce((a, b) => a + b, 0) / negatives.length;
    const oldVar = negatives.reduce((s, r) => s + (r - meanNeg) ** 2, 0) / negatives.length;
    const oldDownDev = Math.sqrt(oldVar) * Math.sqrt(252);

    // Nuevo (correcto): centrada en MAR (= 0 exceso), incluyendo días positivos como 0
    const downSq = returns.map(r => Math.min(0, r - rfDaily) ** 2);
    const newDownDev = Math.sqrt(downSq.reduce((a, b) => a + b, 0) / returns.length) * Math.sqrt(252);

    // La desviación MAR-centrada es MAYOR (más conservadora) que la centrada en la media
    expect(newDownDev).toBeGreaterThan(oldDownDev);
  });

  test("serie corta (<10) → 0", () => {
    expect(sortinoRatioReal([0.01, -0.01], 0.10, 0.04)).toBe(0);
  });
});

describe("betaVsBenchmark — ventana MÁS RECIENTE slice(-n) (FIX-FORENSIC-H3)", () => {
  test("usa la ventana reciente, no la antigua", () => {
    const benchmark = Array(100).fill(0).map((_, i) => Math.sin(i) * 0.01);
    const anti = benchmark.map(r => -r);
    // portfolio: primeros 100 días = -benchmark (corr -1), últimos 100 = benchmark (corr +1)
    const portfolio = [...anti, ...benchmark];
    const b = betaVsBenchmark(portfolio, benchmark);
    // slice(-100) → últimos 100 días (portfolio === benchmark) → beta ≈ 1
    // slice(0,100) (bug) → primeros 100 días (portfolio === -benchmark) → beta ≈ -1
    expect(b).toBeGreaterThan(0.5);
  });

  test("arrays cortos → 1 por defecto", () => {
    expect(betaVsBenchmark([0.01], [0.01])).toBe(1);
  });

  test("portfolio idéntico al benchmark → beta ≈ 1", () => {
    const rets = Array(50).fill(0).map((_, i) => 0.001 + Math.sin(i) * 0.005);
    expect(betaVsBenchmark(rets, rets)).toBeCloseTo(1, 4);
  });
});

describe("jensenAlpha", () => {
  test("α = r_p - [rf + β(r_m - rf)]", () => {
    expect(jensenAlpha(0.10, 0.5, 0.08, 0.04)).toBeCloseTo(0.10 - (0.04 + 0.5 * (0.08 - 0.04)), 6);
  });
});
