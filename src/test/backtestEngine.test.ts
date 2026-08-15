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
