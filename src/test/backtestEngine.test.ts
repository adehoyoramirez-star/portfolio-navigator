// ============================================================
// src/test/backtestEngine.test.ts
// Tests de regresión para computeMetrics del backtest.
// ============================================================
import { describe, test, expect } from "vitest";
import {
  computeMetrics,
  dailyTrendReductionMultiplier,
  deductTransactionCost,
  driftPortfolioWeights,
  netDailyReturnFromNav,
  runBacktest,
} from "../core/backtest/backtestEngine";
import { sortino } from "../lib/riskMetrics";
import { ASSETS, RISK_FREE_RATE_ANNUAL } from "../lib/constants";

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
    useDynamicCovariance: false,
  };
}

describe("transaction cost reporting", () => {
  test("empty backtest reports zero observed transaction-cost bps", () => {
    const input = syntheticBacktestInput();
    for (const ticker of Object.keys(input.closesHistory)) {
      input.closesHistory[ticker] = input.closesHistory[ticker].slice(0, 20);
    }
    const result = runBacktest(input);
    expect(result.rebalanceCount).toBe(0);
    expect(result.totalTransactionCosts).toBe(0);
    expect(result.transactionCostBps).toBe(0);
  });

  test("net daily returns reconcile exactly to strategy and benchmark NAVs", () => {
    const input = syntheticBacktestInput();
    const result = runBacktest(input);

    expect(result.totalTransactionCosts).toBeGreaterThan(0);
    expect(result.dailyNetReturns).toHaveLength(result.dailyRecords.length);
    expect(result.benchmarkNetReturns).toHaveLength(result.dailyRecords.length);
    expect(result.institutionalBenchmarkNetReturns).toHaveLength(result.dailyRecords.length);

    let nav = input.initialCapital;
    result.dailyRecords.forEach((record, index) => {
      nav *= 1 + result.dailyNetReturns[index];
      expect(Math.abs(nav - record.portfolioValue)).toBeLessThan(Math.max(1e-8, Math.abs(nav) * 1e-12));
    });
    expect(Math.abs(nav - result.metrics.finalValue)).toBeLessThan(Math.max(1e-8, Math.abs(nav) * 1e-12));

    const reconstructedBenchmark = input.initialCapital
      * result.benchmarkNetReturns.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1);
    const reconstructedInstitutional = input.initialCapital
      * result.institutionalBenchmarkNetReturns.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1);
    expect(Math.abs(reconstructedBenchmark - result.benchmarkMetrics.finalValue))
      .toBeLessThan(Math.max(1e-8, Math.abs(reconstructedBenchmark) * 1e-12));
    expect(Math.abs(reconstructedInstitutional - result.institutionalBenchmarkMetrics.finalValue))
      .toBeLessThan(Math.max(1e-8, Math.abs(reconstructedInstitutional) * 1e-12));

    for (const record of result.dailyRecords) {
      const invested = Object.values(record.allocations).reduce((sum, weight) => sum + weight, 0);
      expect(Math.abs(invested + record.cash - 1)).toBeLessThanOrEqual(1e-8);
    }

    const expectedMetrics = computeMetrics(
      result.dailyNetReturns,
      input.initialCapital,
      result.metrics.finalValue,
      result.benchmarkNetReturns,
    );
    expect(result.metrics.sharpe).toBeCloseTo(expectedMetrics.sharpe, 10);
    expect(result.metrics.sortino).toBeCloseTo(expectedMetrics.sortino, 10);
    expect(result.metrics.volatility).toBeCloseTo(expectedMetrics.volatility, 10);
    expect(result.metrics.maxDrawdown).toBeCloseTo(expectedMetrics.maxDrawdown, 10);
    expect(result.metrics.calmar).toBeCloseTo(expectedMetrics.calmar, 10);
    expect(result.metrics.alphaVsBenchmark).toBeCloseTo(expectedMetrics.alphaVsBenchmark, 10);
    expect(result.metrics.betaVsBenchmark).toBeCloseTo(expectedMetrics.betaVsBenchmark, 10);
  });
});

describe("daily trend filter and cash accounting", () => {
  test("charges a known close cost after market P&L and returns the net close-to-close rate", () => {
    const previousNav = 10_000;
    const navAfterMarket = previousNav * 1.01;
    const navAfterCost = deductTransactionCost(navAfterMarket, 10);
    const netReturn = netDailyReturnFromNav(previousNav, navAfterCost);

    expect(navAfterCost).toBe(10_090);
    expect(netReturn).toBeCloseTo(0.009, 12);
    expect(previousNav * (1 + netReturn)).toBeCloseTo(navAfterCost, 10);
  });

  test("the 50-day trigger is eligible at day 50, without requiring 200 observations", () => {
    const closes = Array(51).fill(100);
    closes[50] = 80;

    expect(dailyTrendReductionMultiplier(closes, 49)).toBeNull();
    expect(dailyTrendReductionMultiplier(closes, 50)).toBe(0.5);
  });

  test("the 200-day mild trigger remains distinct from the 50-day severe trigger", () => {
    const closes = Array(201).fill(100);
    closes[200] = 89;

    expect(dailyTrendReductionMultiplier(closes, 200)).toBe(0.65);
  });

  test("holdings and zero-yield cash drift together and preserve total exposure", () => {
    const assetA = ASSETS[0]!;
    const assetB = ASSETS[1]!;
    const drifted = driftPortfolioWeights(
      { [assetA]: 0.4, [assetB]: 0.4 },
      0.2,
      { [assetA]: 0.1, [assetB]: 0 },
    );

    expect(drifted.allocations[assetA]).toBeCloseTo(0.44 / 1.04, 12);
    expect(drifted.allocations[assetB]).toBeCloseTo(0.4 / 1.04, 12);
    expect(drifted.cash).toBeCloseTo(0.2 / 1.04, 12);
    const total = Object.values(drifted.allocations).reduce((sum, weight) => sum + weight, 0) + drifted.cash;
    expect(total).toBeCloseTo(1, 12);
  });
});

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

  test("final NAV at zero reports a complete loss", () => {
    const metrics = computeMetrics([-1], 10_000, 0);
    expect(metrics.totalReturn).toBe(-1);
    expect(metrics.cagr).toBe(-1);
    expect(metrics.maxDrawdown).toBe(-1);
  });
});
