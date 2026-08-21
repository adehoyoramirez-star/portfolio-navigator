// ============================================================
// src/test/backtestEngine.test.ts
// Tests de regresión para computeMetrics del backtest.
// ============================================================
import { describe, test, expect } from "vitest";
import { computeMetrics, runBacktest } from "../core/backtest/backtestEngine";
import { sortino } from "../lib/riskMetrics";
import { RISK_FREE_RATE_ANNUAL } from "../lib/constants";

// Helper: serie sintética 10 años con una caída en el año 5 (para que el DD
// del sleeve motor sea distinto de un override forzado).
function syntheticBacktestInput() {
  const days = 10 * 365;
  const closes: Record<string, number[]> = {};
  const tickers = ["BTC-EUR", "EMXC.DE", "PPFB.DE", "URNU.DE", "VVSM.DE", "0P00000WLG.F"];
  for (const t of tickers) {
    const arr: number[] = [];
    let p = 100;
    for (let i = 0; i < days; i++) {
      // Rally + crash en año 5 (i en [4*365, 5*365]): caída -40% gradual
      const inCrash = i >= 4 * 365 && i < 5 * 365;
      const drift = inCrash ? -0.003 : 0.0008;
      const noise = (Math.sin(i * 1.7) * 0.002) + (Math.cos(i * 0.9) * 0.0015);
      p *= (1 + drift + noise);
      arr.push(p);
    }
    closes[t] = arr;
  }
  const macroSeries = (v: number) => Array(days).fill(v);
  return {
    closesHistory: closes,
    macroHistory: {
      vix: macroSeries(16),
      yieldSpread: macroSeries(0.8),
      creditSpread: macroSeries(2.5),
      erpValue: macroSeries(0.03),
      avgCorrelation: macroSeries(0.35),
    },
    lookbackDays: 252,
    rebalanceDays: 21,
    initialCapital: 10_000,
    transactionCostBps: 15,
    useDynamicCovariance: false,
  };
}

describe("portfolioDrawdownOverride (FIX-ACOPLAMIENTO-SATELITE)", () => {
  test("sin override → comportamiento idéntico al baseline (DD sleeve motor)", () => {
    const input = syntheticBacktestInput();
    const base = runBacktest(input);
    // override que reproduce EXACTAMENTE el default (DD del sleeve)
    const replica = runBacktest({
      ...input,
      portfolioDrawdownOverride: (pv, peak) => (pv < peak ? (pv - peak) / peak : 0),
    });
    expect(replica.metrics.cagr).toBeCloseTo(base.metrics.cagr, 10);
    expect(replica.metrics.sharpe).toBeCloseTo(base.metrics.sharpe, 10);
    expect(replica.metrics.maxDrawdown).toBeCloseTo(base.metrics.maxDrawdown, 10);
    expect(replica.dailyRecords.length).toBe(base.dailyRecords.length);
    // Las allocations del último rebalanceo deben coincidir
    const lastBase = base.dailyRecords[base.dailyRecords.length - 1].allocations;
    const lastRep = replica.dailyRecords[replica.dailyRecords.length - 1].allocations;
    for (const k of Object.keys(lastBase)) expect(lastRep[k]).toBeCloseTo(lastBase[k], 10);
  });

  test("override forzado (DD = 0 siempre) → el motor NO recibe DD → no activa tail risk por drawdown", () => {
    const input = syntheticBacktestInput();
    const base = runBacktest(input);
    const noDD = runBacktest({ ...input, portfolioDrawdownOverride: () => 0 });
    // Con DD=0 el tail risk por drawdown nunca se activa → cartera más expuesta
    // en el crash del año 5 → MaxDD más profundo (o al menos distinto).
    expect(noDD.metrics.maxDrawdown).toBeLessThanOrEqual(base.metrics.maxDrawdown + 1e-9);
  });

  test("override forzado extremo (DD = -50% siempre) → kill switch en modo máximo → mucha menos exposición", () => {
    const input = syntheticBacktestInput();
    const base = runBacktest(input);
    const deepDD = runBacktest({ ...input, portfolioDrawdownOverride: () => -0.5 });
    // Con DD=-50% el tail risk reduce la exposición a su mínimo (L5) en TODOS
    // los rebalanceos → el valor crece mucho menos que el baseline.
    expect(deepDD.metrics.finalValue).toBeLessThan(base.metrics.finalValue * 0.9);
  });
});

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
