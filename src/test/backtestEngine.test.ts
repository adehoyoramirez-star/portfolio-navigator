// ============================================================
// src/test/backtestEngine.test.ts
// Tests de regresión para computeMetrics del backtest.
// ============================================================
import { describe, test, expect } from "vitest";
import { computeMetrics } from "../core/backtest/backtestEngine";
import { sortino } from "../lib/riskMetrics";
import { RISK_FREE_RATE_ANNUAL } from "../lib/constants";

describe("computeMetrics — sortino con MAR = rf (FIX-FORENSIC-H2)", () => {
  test("sortino usa rf como MAR, no 0", () => {
    // Retornos ligeramente positivos pero POR DEBAJO del rf diario (0.04/252 ≈ 0.000159).
    // Con MAR=0 → sin downside → sortino = 999 (antiguo bug).
    // Con MAR=rf → estos retornos cuentan como downside → sortino negativo.
    const dailyRets = Array(252).fill(0.0001);
    const initialCapital = 10000;
    let finalValue = initialCapital;
    for (const r of dailyRets) finalValue *= (1 + r);

    const metrics = computeMetrics(dailyRets, initialCapital, finalValue);

    const expected = sortino(dailyRets, RISK_FREE_RATE_ANNUAL, RISK_FREE_RATE_ANNUAL); // MAR = rf (fix)
    const buggy = sortino(dailyRets, RISK_FREE_RATE_ANNUAL, 0);                        // MAR = 0 (bug antiguo)

    // El fix usa MAR = rf
    expect(metrics.sortino).toBeCloseTo(expected, 6);
    // Y difiere del bug antiguo (que devolvía 999 con retornos positivos)
    expect(buggy).toBe(999);
    expect(metrics.sortino).not.toBe(999);
  });

  test("retornos profundamente negativos → sortino negativo (coherente)", () => {
    const dailyRets = Array(252).fill(-0.01);
    const initialCapital = 10000;
    let finalValue = initialCapital;
    for (const r of dailyRets) finalValue *= (1 + r);

    const metrics = computeMetrics(dailyRets, initialCapital, finalValue);
    expect(metrics.sortino).toBeLessThan(0);
  });
});

describe("computeMetrics — Profit Factor y rachas (FIX-METRICS-INST)", () => {
  test("todo positivo → PF=999, racha ganadora = 12 periodos", () => {
    const dailyRets = Array(252).fill(0.001);
    const initialCapital = 10000;
    let finalValue = initialCapital;
    for (const r of dailyRets) finalValue *= (1 + r);

    const m = computeMetrics(dailyRets, initialCapital, finalValue);
    expect(m.periods).toBe(12);          // 252/21 = 12 buckets mensuales
    expect(m.profitFactor).toBe(999);     // sin meses en pérdida
    expect(m.maxWinStreak).toBe(12);
    expect(m.maxLossStreak).toBe(0);
  });

  test("6 meses up + 6 meses down → PF≈1, rachas 6/6", () => {
    const up = Array(126).fill(0.001);    // 6 meses positivos
    const down = Array(126).fill(-0.001); // 6 meses negativos
    const dailyRets = [...up, ...down];
    const initialCapital = 10000;
    let finalValue = initialCapital;
    for (const r of dailyRets) finalValue *= (1 + r);

    const m = computeMetrics(dailyRets, initialCapital, finalValue);
    expect(m.periods).toBe(12);
    expect(m.maxWinStreak).toBe(6);
    expect(m.maxLossStreak).toBe(6);
    expect(m.winRate).toBeCloseTo(0.5, 6);
    // PF ≈ 1 (ganancias ≈ pérdidas). Rango amplio para absorber float.
    expect(m.profitFactor).toBeGreaterThan(0.9);
    expect(m.profitFactor).toBeLessThan(1.2);
  });
});
